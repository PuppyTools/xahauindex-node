import type {
  DexTrade,
  HookDefinition,
  HookEntry,
  HookParameter,
  HookState,
  Issuer,
  OHLCVCandle,
  Token,
  TrustLine,
  URIToken,
} from '../types/api.js';
import type { SqliteDatabase } from '../db/client.js';
import { listHookDefinitionsByHashes } from '../db/queries/hooks.js';
import { parseStoredTomlLinks } from '../util/domain.js';
import { decodeHookOn } from '../util/hookOn.js';
import { metadataFromRow } from '../util/icon.js';
import { classifyUri, resolveUriTokenMetadata } from '../util/uriPayload.js';
import type {
  DexTradeRow,
  HookAccountRow,
  HookDefinitionRow,
  IssuerRow,
  OhlcvCandleRow,
  TokenRow,
  TrustLineRow,
  UriTokenRow,
} from '../types/db.js';

export function boolFromInt(value: number): boolean {
  return value === 1;
}

export function tokenFromRow(row: TokenRow, remarks?: Record<string, string>): Token {
  return {
    id: row.id,
    currency: row.currency,
    currency_hex: row.currency_hex,
    issuer: row.issuer,
    name: row.name,
    description: row.description,
    icon_url: row.icon_url,
    website_url: row.website_url,
    toml_links: parseStoredTomlLinks(row.toml_links),
    supply: row.supply,
    holder_count: row.holder_count,
    trust_count: row.trust_count,
    domain_verified: boolFromInt(row.domain_verified),
    blackholed: boolFromInt(row.blackholed),
    first_ledger: row.first_ledger,
    last_updated: row.last_updated,
    ...(remarks === undefined ? {} : { remarks }),
  };
}

export function issuerFromRow(
  row: IssuerRow,
  extras?: { tokenCount?: number; remarks?: Record<string, string> },
): Issuer {
  return {
    account: row.account,
    domain: row.domain,
    domain_verified: boolFromInt(row.domain_verified),
    email_hash: row.email_hash,
    transfer_rate: row.transfer_rate,
    flags: row.flags,
    blackholed: boolFromInt(row.blackholed),
    toml_name: row.toml_name,
    toml_description: row.toml_description,
    toml_icon_url: row.toml_icon_url,
    toml_links: parseStoredTomlLinks(row.toml_links),
    has_hooks: boolFromInt(row.has_hooks),
    ...(extras?.tokenCount === undefined ? {} : { token_count: extras.tokenCount }),
    first_ledger: row.first_ledger,
    last_updated: row.last_updated,
    ...(extras?.remarks === undefined ? {} : { remarks: extras.remarks }),
  };
}

export function uriTokenFromRow(
  row: UriTokenRow,
  extras?: { remarks?: Record<string, string>; transferCount?: number },
): URIToken {
  let sellOffer: URIToken['sell_offer'] = null;
  if (row.sell_offer) {
    try {
      sellOffer = JSON.parse(row.sell_offer) as URIToken['sell_offer'];
    } catch {
      sellOffer = row.sell_offer;
    }
  }
  return {
    id: row.id,
    uri: row.uri,
    uri_raw: row.uri_raw,
    uri_kind: classifyUri(row.uri),
    digest: row.digest,
    issuer: row.issuer,
    owner: row.owner,
    flags: row.flags,
    sell_offer: sellOffer,
    destination: row.destination,
    burned: boolFromInt(row.burned),
    burn_ledger: row.burn_ledger,
    mint_ledger: row.mint_ledger,
    last_updated: row.last_updated,
    icon_url: row.icon_url,
    metadata: resolveUriTokenMetadata(row.uri, row.uri_raw, metadataFromRow(row.uri_metadata)),
    ...(extras?.remarks === undefined ? {} : { remarks: extras.remarks }),
    ...(extras?.transferCount === undefined ? {} : { transfer_count: extras.transferCount }),
  };
}

export function trustLineFromRow(row: TrustLineRow, remarks?: Record<string, string>): TrustLine {
  return {
    account: row.account,
    currency: row.currency,
    issuer: row.issuer,
    balance: row.balance,
    limit_peer: row.limit_peer,
    flags: row.flags,
    ...(remarks === undefined ? {} : { remarks }),
  };
}

export function candleFromRow(row: OhlcvCandleRow): OHLCVCandle {
  return {
    open_time: row.open_time,
    open_ledger: row.open_ledger,
    close_ledger: row.close_ledger,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    trade_count: row.trade_count,
  };
}

export function tradeFromRow(row: DexTradeRow): DexTrade {
  return {
    base_currency: row.base_currency,
    base_issuer: row.base_issuer,
    counter_currency: row.counter_currency,
    counter_issuer: row.counter_issuer,
    price: row.price,
    base_amount: row.base_amount,
    counter_amount: row.counter_amount,
    taker: row.taker,
    maker: row.maker,
    ledger_index: row.ledger_index,
    close_time: row.close_time,
    tx_hash: row.tx_hash,
  };
}

function parseHookParameters(raw: string): HookParameter[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as HookParameter[]) : [];
  } catch {
    return [];
  }
}

export function hookDefinitionFromRow(row: HookDefinitionRow): HookDefinition {
  return {
    hook_hash: row.hook_hash,
    hook_namespace: row.hook_namespace,
    hook_on: row.hook_on,
    hook_on_incoming: row.hook_on_incoming,
    hook_on_outgoing: row.hook_on_outgoing,
    hook_can_emit: row.hook_can_emit,
    hook_name: row.hook_name,
    hook_api_version: row.hook_api_version,
    parameters: parseHookParameters(row.parameters_json),
    reference_count: row.reference_count,
    code_size: row.code_size,
    hook_fee: row.hook_fee,
    hook_callback_fee: row.hook_callback_fee,
    hook_set_txn_id: row.hook_set_txn_id,
    flags: row.flags,
    triggers: decodeHookOn(row.hook_on),
    triggers_incoming: decodeHookOn(row.hook_on_incoming),
    triggers_outgoing: decodeHookOn(row.hook_on_outgoing),
    can_emit: decodeHookOn(row.hook_can_emit),
    first_ledger: row.first_ledger,
    last_updated: row.last_updated,
  };
}

function enrichHookEntry(entry: HookEntry, definition: HookDefinition | undefined): HookEntry {
  const hookOn = entry.hook_on ?? definition?.hook_on ?? null;
  const incoming = entry.hook_on_incoming ?? definition?.hook_on_incoming ?? null;
  const outgoing = entry.hook_on_outgoing ?? definition?.hook_on_outgoing ?? null;
  const canEmit = entry.hook_can_emit ?? definition?.hook_can_emit ?? null;
  return {
    ...entry,
    triggers: decodeHookOn(hookOn),
    triggers_incoming: decodeHookOn(incoming),
    triggers_outgoing: decodeHookOn(outgoing),
    can_emit: decodeHookOn(canEmit),
    definition: definition ?? null,
  };
}

export function hookStateFromRow(
  row: HookAccountRow,
  definitions?: ReadonlyMap<string, HookDefinitionRow>,
): HookState {
  let hooks: HookEntry[];
  try {
    hooks = JSON.parse(row.hooks_json) as HookEntry[];
  } catch {
    hooks = [];
  }
  return {
    account: row.account,
    hook_count: row.hook_count,
    hooks: hooks.map((entry) =>
      enrichHookEntry(
        entry,
        definitions?.get(entry.hook_hash.toUpperCase()) ?? definitions?.get(entry.hook_hash),
      ),
    ),
    first_ledger: row.first_ledger,
    last_updated: row.last_updated,
  };
}

export function hookStateFromDb(db: SqliteDatabase, row: HookAccountRow): HookState {
  let hashes: string[] = [];
  try {
    const hooks = JSON.parse(row.hooks_json) as HookEntry[];
    hashes = hooks.map((entry) => entry.hook_hash.toUpperCase()).filter((hash) => hash !== '');
  } catch {
    // keep empty
  }
  return hookStateFromRow(row, listHookDefinitionsByHashes(db, hashes));
}
