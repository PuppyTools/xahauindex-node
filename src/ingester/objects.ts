import type { SqliteDatabase } from '../db/client.js';
import { upsertHookAccount } from '../db/queries/hooks.js';
import { ensureIssuer, updateIssuerOnChain } from '../db/queries/issuers.js';
import { deleteRemark, upsertRemark } from '../db/queries/remarks.js';
import { ensureToken, tokenId, updateTokenDisplay, upsertTrustLine } from '../db/queries/tokens.js';
import { upsertUriToken } from '../db/queries/uritokens.js';
import type { AccountRootObject, RippleStateObject, URITokenObject } from '../types/xahau.js';
import {
  absDecimal,
  decodeCurrency,
  hexToUtf8,
  isBlackholed,
  isValidAccount,
  isZeroDecimal,
  negateDecimal,
  serializeAmount,
} from '../util/xahau.js';
import { parseAccountRoot, parseRippleState, parseUriToken } from './guards.js';
import { normalizeHookEntries } from './hooks.js';
import { parseRemarkArray, remarksToDisplay } from './remarks.js';

export interface ApplyLogger {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

export interface TrustLineView {
  issuer: string;
  holder: string;
  currency: string;
  currencyHex: string | null;
  balance: string;
  limit: string;
}

export function interpretRippleState(object: RippleStateObject): TrustLineView | null {
  const low = object.LowLimit.issuer;
  const high = object.HighLimit.issuer;
  if (!isValidAccount(low) || !isValidAccount(high)) {
    return null;
  }
  const decoded = decodeCurrency(object.Balance.currency || object.LowLimit.currency);
  const lowLimit = object.LowLimit.value;
  const highLimit = object.HighLimit.value;
  const balance = object.Balance.value;
  const lowIsIssuer = isZeroDecimal(lowLimit) && !isZeroDecimal(highLimit);
  const highIsIssuer = isZeroDecimal(highLimit) && !isZeroDecimal(lowLimit);

  if (lowIsIssuer) {
    return {
      issuer: low,
      holder: high,
      currency: decoded.currency,
      currencyHex: decoded.currencyHex,
      balance: absDecimal(negateDecimal(balance)),
      limit: highLimit,
    };
  }
  if (highIsIssuer) {
    return {
      issuer: high,
      holder: low,
      currency: decoded.currency,
      currencyHex: decoded.currencyHex,
      balance: absDecimal(balance),
      limit: lowLimit,
    };
  }
  if (!isZeroDecimal(balance)) {
    if (balance.trim().startsWith('-')) {
      return {
        issuer: low,
        holder: high,
        currency: decoded.currency,
        currencyHex: decoded.currencyHex,
        balance: absDecimal(balance),
        limit: highLimit,
      };
    }
    return {
      issuer: high,
      holder: low,
      currency: decoded.currency,
      currencyHex: decoded.currencyHex,
      balance: absDecimal(balance),
      limit: lowLimit,
    };
  }
  if (!isZeroDecimal(lowLimit) || !isZeroDecimal(highLimit)) {
    const lowFirst = lowLimit.length === highLimit.length ? lowLimit <= highLimit : lowLimit.length < highLimit.length;
    if (lowFirst) {
      return {
        issuer: low,
        holder: high,
        currency: decoded.currency,
        currencyHex: decoded.currencyHex,
        balance: '0',
        limit: highLimit,
      };
    }
    return {
      issuer: high,
      holder: low,
      currency: decoded.currency,
      currencyHex: decoded.currencyHex,
      balance: '0',
      limit: lowLimit,
    };
  }
  return null;
}

function persistRemarks(
  db: SqliteDatabase,
  objectId: string,
  objectType: string,
  remarks: unknown,
  ledger: number,
  links: { uriTokenId?: string; account?: string; tokenId?: string },
): ReturnType<typeof remarksToDisplay> {
  const decoded = parseRemarkArray(remarks);
  for (const remark of decoded) {
    if (remark.deleted) {
      deleteRemark(db, objectId, remark.name);
      continue;
    }
    upsertRemark(db, {
      object_id: objectId,
      object_type: objectType,
      name: remark.name,
      value: remark.value,
      immutable: remark.immutable ? 1 : 0,
      uri_token_id: links.uriTokenId ?? null,
      account: links.account ?? null,
      token_id: links.tokenId ?? null,
      last_updated: ledger,
    });
  }
  return remarksToDisplay(decoded.filter((item) => !item.deleted));
}

export function applyRippleState(
  db: SqliteDatabase,
  object: RippleStateObject,
  ledger: number,
  log: ApplyLogger,
): void {
  const view = interpretRippleState(object);
  if (!view) {
    log.warn({ index: object.index }, 'skipping RippleState with no issuer/holder');
    return;
  }
  ensureIssuer(db, view.issuer, ledger);
  const id = tokenId(view.currency, view.issuer);
  ensureToken(db, {
    id,
    currency: view.currency,
    currency_hex: view.currencyHex,
    issuer: view.issuer,
    first_ledger: ledger,
    last_updated: ledger,
  });
  upsertTrustLine(db, {
    id: `${view.holder}:${view.currency}:${view.issuer}`,
    account: view.holder,
    currency: view.currency,
    issuer: view.issuer,
    balance: view.balance,
    limit_peer: view.limit,
    quality_in: object.QualityIn ?? null,
    quality_out: object.QualityOut ?? null,
    flags: object.Flags ?? null,
    first_ledger: ledger,
    last_updated: ledger,
  });
  if (object.index) {
    const display = persistRemarks(db, object.index, 'RippleState', object.Remarks, ledger, {
      tokenId: id,
      account: view.issuer,
    });
    updateTokenDisplay(db, id, {
      ...(display.name === undefined ? {} : { name: display.name }),
      ...(display.description === undefined ? {} : { description: display.description }),
      ...(display.iconUrl === undefined ? {} : { icon_url: display.iconUrl }),
      ...(display.websiteUrl === undefined ? {} : { website_url: display.websiteUrl }),
    });
  }
}

export function applyUriToken(
  db: SqliteDatabase,
  object: URITokenObject,
  ledger: number,
  log: ApplyLogger,
): void {
  const id = object.index ?? object.URITokenID;
  if (!id) {
    log.warn({ issuer: object.Issuer }, 'skipping URIToken without id');
    return;
  }
  if (!isValidAccount(object.Issuer) || !isValidAccount(object.Owner)) {
    log.warn({ id }, 'skipping URIToken with invalid account');
    return;
  }
  ensureIssuer(db, object.Issuer, ledger);
  const uri = hexToUtf8(object.URI) || object.URI;
  upsertUriToken(db, {
    id,
    uri,
    uri_raw: object.URI,
    digest: object.Digest ?? null,
    issuer: object.Issuer,
    owner: object.Owner,
    flags: object.Flags ?? null,
    sell_offer: serializeAmount(object.Amount),
    destination: object.Destination ?? null,
    burned: 0,
    burn_ledger: null,
    mint_ledger: object.PreviousTxnLgrSeq ?? ledger,
    last_updated: ledger,
  });
  persistRemarks(db, id, 'URIToken', object.Remarks, ledger, { uriTokenId: id });
}

export type AccountRootCache = Map<string, AccountRootObject>;

export function cacheAccountRoot(cache: AccountRootCache, object: AccountRootObject): void {
  if (isValidAccount(object.Account)) {
    cache.set(object.Account, object);
  }
}

export function applyAccountRoot(db: SqliteDatabase, object: AccountRootObject, ledger: number): void {
  if (!isValidAccount(object.Account)) {
    return;
  }
  const hooks = object.Hook ? normalizeHookEntries(object.Hook) : [];
  const hasHooks = hooks.length > 0;
  const domain = object.Domain ? hexToUtf8(object.Domain) || null : null;
  const blackholed = isBlackholed(object.Flags, object.RegularKey) ? 1 : 0;
  const knownIssuer = issuerExists(db, object.Account);

  if (domain || hasHooks || knownIssuer) {
    ensureIssuer(db, object.Account, ledger);
    updateIssuerOnChain(db, {
      account: object.Account,
      domain,
      email_hash: object.EmailHash ?? null,
      transfer_rate: object.TransferRate ?? null,
      flags: object.Flags ?? null,
      blackholed,
      has_hooks: hasHooks ? 1 : 0,
      last_updated: ledger,
    });
  }

  if (hasHooks) {
    const existing = db
      .prepare('SELECT first_ledger FROM hook_accounts WHERE account = ?')
      .get(object.Account) as { first_ledger: number } | undefined;
    upsertHookAccount(db, {
      account: object.Account,
      hook_count: hooks.length,
      hooks_json: JSON.stringify(hooks),
      first_ledger: existing?.first_ledger ?? ledger,
      last_updated: ledger,
    });
  }

  if (object.index) {
    persistRemarks(db, object.index, 'AccountRoot', object.Remarks, ledger, {
      account: object.Account,
    });
  }
}

function issuerExists(db: SqliteDatabase, account: string): boolean {
  const row = db.prepare('SELECT account FROM issuers WHERE account = ?').get(account) as
    | { account: string }
    | undefined;
  return row !== undefined;
}

export function applyCachedAccountRoots(
  db: SqliteDatabase,
  cache: AccountRootCache,
  ledger: number,
): void {
  for (const object of cache.values()) {
    applyAccountRoot(db, object, ledger);
  }
}

export function applyLedgerObject(
  db: SqliteDatabase,
  raw: unknown,
  ledger: number,
  log: ApplyLogger,
  accountCache: AccountRootCache,
): void {
  const ripple = parseRippleState(raw);
  if (ripple) {
    applyRippleState(db, ripple, ledger, log);
    return;
  }
  const uriToken = parseUriToken(raw);
  if (uriToken) {
    applyUriToken(db, uriToken, ledger, log);
    return;
  }
  const account = parseAccountRoot(raw);
  if (account) {
    cacheAccountRoot(accountCache, account);
    if (account.Domain || (account.Hook && account.Hook.length > 0)) {
      applyAccountRoot(db, account, ledger);
    }
  }
}
