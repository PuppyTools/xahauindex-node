import type { SqliteDatabase } from '../db/client.js';
import { getHookAccount, upsertHookAccount } from '../db/queries/hooks.js';
import { ensureIssuer, getIssuer, updateIssuerOnChain } from '../db/queries/issuers.js';
import { deleteRemark, listRemarksByObject, upsertRemark } from '../db/queries/remarks.js';
import {
  deleteTrustLine,
  ensureToken,
  tokenId,
  updateTokenDisplay,
  upsertTrustLine,
} from '../db/queries/tokens.js';
import {
  getUriToken,
  insertUriTokenTransfer,
  markUriTokenBurned,
  upsertUriToken,
} from '../db/queries/uritokens.js';
import type { Amount, AccountRootObject, RippleStateObject, URITokenObject } from '../types/xahau.js';
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
import {
  parseAccountRoot,
  parseRippleState,
  parseUriToken,
  type ParsedAffectedNode,
} from './guards.js';
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

export function persistRemarks(
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
): string | null {
  const view = interpretRippleState(object);
  if (!view) {
    log.warn({ index: object.index }, 'skipping RippleState with no issuer/holder');
    return null;
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
  return id;
}

export function applyDeletedRippleState(
  db: SqliteDatabase,
  object: RippleStateObject,
  log: ApplyLogger,
): string | null {
  const view = interpretRippleState(object);
  if (!view) {
    log.warn({ index: object.index }, 'skipping deleted RippleState with no issuer/holder');
    return null;
  }
  deleteTrustLine(db, `${view.holder}:${view.currency}:${view.issuer}`);
  return tokenId(view.currency, view.issuer);
}

export function applyUriToken(
  db: SqliteDatabase,
  object: URITokenObject,
  ledger: number,
  log: ApplyLogger,
): void {
  applyUriTokenFields(db, object, ledger, log);
}

export function applyUriTokenFields(
  db: SqliteDatabase,
  object: URITokenObject,
  ledger: number,
  log: ApplyLogger,
  options?: {
    fields?: Record<string, unknown>;
    previous?: Record<string, unknown>;
    transfer?: { txHash: string; price: string | null };
  },
): string | null {
  const id = object.index ?? object.URITokenID;
  if (!id) {
    log.warn({ issuer: object.Issuer }, 'skipping URIToken without id');
    return null;
  }
  if (!isValidAccount(object.Issuer) || !isValidAccount(object.Owner)) {
    log.warn({ id }, 'skipping URIToken with invalid account');
    return null;
  }
  ensureIssuer(db, object.Issuer, ledger);
  const existing = getUriToken(db, id);
  const fields = options?.fields;
  const previous = options?.previous;
  const sellOffer = resolveMergedAmount(object.Amount, existing?.sell_offer ?? null, fields, previous, 'Amount');
  const destination = resolveMergedString(
    object.Destination,
    existing?.destination ?? null,
    fields,
    previous,
    'Destination',
  );
  const uri = hexToUtf8(object.URI) || object.URI;
  upsertUriToken(db, {
    id,
    uri,
    uri_raw: object.URI,
    digest: object.Digest ?? existing?.digest ?? null,
    issuer: object.Issuer,
    owner: object.Owner,
    flags: object.Flags ?? existing?.flags ?? null,
    sell_offer: sellOffer,
    destination,
    burned: 0,
    burn_ledger: existing?.burn_ledger ?? null,
    mint_ledger: existing?.mint_ledger ?? object.PreviousTxnLgrSeq ?? ledger,
    last_updated: ledger,
  });
  if (fields === undefined || 'Remarks' in fields) {
    persistRemarks(db, id, 'URIToken', object.Remarks, ledger, { uriTokenId: id });
  }

  const previousOwner =
    previous !== undefined && typeof previous.Owner === 'string' ? previous.Owner : undefined;
  const createdTransfer =
    previousOwner === undefined && existing === undefined && object.Owner !== object.Issuer;
  const ownerChanged = previousOwner !== undefined && previousOwner !== object.Owner;
  if ((createdTransfer || ownerChanged) && options?.transfer && options.transfer.txHash !== '') {
    insertUriTokenTransfer(db, {
      uri_token_id: id,
      from_account: previousOwner ?? object.Issuer,
      to_account: object.Owner,
      price: options.transfer.price,
      ledger_index: ledger,
      tx_hash: options.transfer.txHash,
    });
  }
  return id;
}

export function applyDeletedUriToken(
  db: SqliteDatabase,
  object: URITokenObject,
  ledger: number,
  log: ApplyLogger,
): void {
  const id = applyUriTokenFields(db, object, ledger, log);
  if (!id) {
    return;
  }
  markUriTokenBurned(db, id, ledger);
}

export type AccountRootCache = Map<string, AccountRootObject>;

export function cacheAccountRoot(cache: AccountRootCache, object: AccountRootObject): void {
  if (isValidAccount(object.Account)) {
    cache.set(object.Account, object);
  }
}

export function applyAccountRoot(
  db: SqliteDatabase,
  object: AccountRootObject,
  ledger: number,
  fields?: Record<string, unknown>,
): void {
  if (!isValidAccount(object.Account)) {
    return;
  }
  const existingIssuer = getIssuer(db, object.Account);
  const hookFieldsPresent = fields === undefined || 'Hook' in fields;
  const hooks = object.Hook ? normalizeHookEntries(object.Hook) : [];
  const hasHooks = hookFieldsPresent ? hooks.length > 0 : existingIssuer?.has_hooks === 1;
  const domain =
    fields !== undefined && !('Domain' in fields)
      ? (existingIssuer?.domain ?? null)
      : object.Domain
        ? hexToUtf8(object.Domain) || null
        : null;
  const flags =
    fields !== undefined && !('Flags' in fields) ? (existingIssuer?.flags ?? null) : (object.Flags ?? null);
  const emailHash =
    fields !== undefined && !('EmailHash' in fields)
      ? (existingIssuer?.email_hash ?? null)
      : (object.EmailHash ?? null);
  const transferRate =
    fields !== undefined && !('TransferRate' in fields)
      ? (existingIssuer?.transfer_rate ?? null)
      : (object.TransferRate ?? null);
  const blackholed =
    fields !== undefined && !('Flags' in fields)
      ? (existingIssuer?.blackholed ?? 0)
      : isBlackholed(object.Flags, object.RegularKey)
        ? 1
        : 0;
  const knownIssuer = existingIssuer !== undefined;

  if (domain || hasHooks || knownIssuer) {
    ensureIssuer(db, object.Account, ledger);
    updateIssuerOnChain(db, {
      account: object.Account,
      domain,
      email_hash: emailHash,
      transfer_rate: transferRate,
      flags,
      blackholed,
      has_hooks: hasHooks ? 1 : 0,
      last_updated: ledger,
    });
  }

  if (hookFieldsPresent) {
    const existingHook = getHookAccount(db, object.Account);
    if (hasHooks || existingHook) {
      upsertHookAccount(db, {
        account: object.Account,
        hook_count: hooks.length,
        hooks_json: JSON.stringify(hooks),
        first_ledger: existingHook?.first_ledger ?? ledger,
        last_updated: ledger,
      });
    }
  }

  if (object.index && (fields === undefined || 'Remarks' in fields)) {
    persistRemarks(db, object.index, 'AccountRoot', object.Remarks, ledger, {
      account: object.Account,
    });
  }
}

function resolveMergedAmount(
  parsed: Amount | undefined,
  existing: string | null,
  fields: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (fields === undefined || key in fields) {
    return serializeAmount(parsed);
  }
  if (previous !== undefined && key in previous) {
    return null;
  }
  return existing;
}

function resolveMergedString(
  parsed: string | undefined,
  existing: string | null,
  fields: Record<string, unknown> | undefined,
  previous: Record<string, unknown> | undefined,
  key: string,
): string | null {
  if (fields === undefined || key in fields) {
    return parsed ?? null;
  }
  if (previous !== undefined && key in previous) {
    return null;
  }
  return existing;
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

export function applyAffectedLedgerNode(
  db: SqliteDatabase,
  node: ParsedAffectedNode,
  ledger: number,
  log: ApplyLogger,
  transfer?: { txHash: string; price: string | null },
): string | null {
  const raw = { LedgerEntryType: node.type, index: node.index, ...node.fields };
  if (node.type === 'RippleState') {
    const ripple = parseRippleState(raw);
    if (!ripple) {
      log.warn({ index: node.index, kind: node.kind }, 'skipping malformed RippleState node');
      return null;
    }
    if (node.kind === 'deleted') {
      return applyDeletedRippleState(db, ripple, log);
    }
    return applyRippleState(db, ripple, ledger, log);
  }
  if (node.type === 'URIToken') {
    const uriToken = parseUriToken(raw);
    if (!uriToken) {
      log.warn({ index: node.index, kind: node.kind }, 'skipping malformed URIToken node');
      return null;
    }
    if (node.kind === 'deleted') {
      applyDeletedUriToken(db, uriToken, ledger, log);
      return null;
    }
    applyUriTokenFields(db, uriToken, ledger, log, {
      fields: node.fields,
      ...(node.previous === undefined ? {} : { previous: node.previous }),
      ...(transfer === undefined ? {} : { transfer }),
    });
    return null;
  }
  if (node.type === 'AccountRoot') {
    const account = parseAccountRoot(raw);
    if (!account) {
      return null;
    }
    applyAccountRoot(db, account, ledger, node.fields);
  }
  return null;
}

export function resolveRemarkTarget(
  db: SqliteDatabase,
  objectId: string,
): { objectType: string; links: { uriTokenId?: string; account?: string; tokenId?: string } } {
  const uri = getUriToken(db, objectId);
  if (uri) {
    return { objectType: 'URIToken', links: { uriTokenId: objectId } };
  }
  const existing = listRemarksByObject(db, objectId)[0];
  if (existing) {
    return {
      objectType: existing.object_type,
      links: {
        ...(existing.uri_token_id === null ? {} : { uriTokenId: existing.uri_token_id }),
        ...(existing.account === null ? {} : { account: existing.account }),
        ...(existing.token_id === null ? {} : { tokenId: existing.token_id }),
      },
    };
  }
  return { objectType: 'Other', links: {} };
}

export function applySetRemarks(
  db: SqliteDatabase,
  objectId: string,
  remarks: unknown,
  ledger: number,
): void {
  const target = resolveRemarkTarget(db, objectId);
  const display = persistRemarks(db, objectId, target.objectType, remarks, ledger, target.links);
  if (target.links.tokenId) {
    updateTokenDisplay(db, target.links.tokenId, {
      ...(display.name === undefined ? {} : { name: display.name }),
      ...(display.description === undefined ? {} : { description: display.description }),
      ...(display.iconUrl === undefined ? {} : { icon_url: display.iconUrl }),
      ...(display.websiteUrl === undefined ? {} : { website_url: display.websiteUrl }),
    });
  }
}
