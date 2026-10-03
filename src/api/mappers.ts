import type { DexTrade, HookState, Issuer, OHLCVCandle, Token, TrustLine, URIToken } from '../types/api.js';
import type {
  DexTradeRow,
  HookAccountRow,
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

export function hookStateFromRow(row: HookAccountRow): HookState {
  let hooks: HookState['hooks'];
  try {
    hooks = JSON.parse(row.hooks_json) as HookState['hooks'];
  } catch {
    hooks = [];
  }
  return {
    account: row.account,
    hook_count: row.hook_count,
    hooks,
    first_ledger: row.first_ledger,
    last_updated: row.last_updated,
  };
}
