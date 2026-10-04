export type SqliteBool = 0 | 1;

export interface IndexerStateRow {
  key: string;
  value: string;
}

export interface LedgerRow {
  ledger_index: number;
  close_time: number;
  hash: string;
  tx_count: number;
  indexed_at: number;
}

export interface TokenRow {
  id: string;
  currency: string;
  currency_hex: string | null;
  issuer: string;
  name: string | null;
  description: string | null;
  icon_url: string | null;
  website_url: string | null;
  toml_links: string | null;
  supply: string | null;
  holder_count: number;
  trust_count: number;
  domain_verified: SqliteBool;
  blackholed: SqliteBool;
  first_ledger: number;
  last_updated: number;
}

export interface TrustLineRow {
  id: string;
  account: string;
  currency: string;
  issuer: string;
  balance: string;
  limit_peer: string;
  quality_in: number | null;
  quality_out: number | null;
  flags: number | null;
  first_ledger: number;
  last_updated: number;
}

export interface IssuerRow {
  account: string;
  domain: string | null;
  domain_verified: SqliteBool;
  email_hash: string | null;
  transfer_rate: number | null;
  flags: number | null;
  blackholed: SqliteBool;
  toml_name: string | null;
  toml_description: string | null;
  toml_icon_url: string | null;
  toml_links: string | null;
  toml_raw: string | null;
  toml_checked_ledger: number | null;
  has_hooks: SqliteBool;
  first_ledger: number;
  last_updated: number;
}

export interface UriTokenRow {
  id: string;
  uri: string | null;
  uri_raw: string;
  digest: string | null;
  issuer: string;
  owner: string;
  flags: number | null;
  sell_offer: string | null;
  destination: string | null;
  burned: SqliteBool;
  burn_ledger: number | null;
  mint_ledger: number;
  last_updated: number;
  icon_url: string | null;
  uri_metadata: string | null;
  uri_meta_checked_ledger: number | null;
}

export interface UriTokenTransferRow {
  id: number;
  uri_token_id: string;
  from_account: string;
  to_account: string;
  price: string | null;
  ledger_index: number;
  tx_hash: string;
}

export type RemarkObjectType = 'URIToken' | 'AccountRoot' | 'RippleState' | 'Other';

export interface RemarkRow {
  object_id: string;
  object_type: string;
  name: string;
  value: string;
  immutable: SqliteBool;
  uri_token_id: string | null;
  account: string | null;
  token_id: string | null;
  last_updated: number;
}

export interface HookAccountRow {
  account: string;
  hook_count: number;
  hooks_json: string;
  first_ledger: number;
  last_updated: number;
}

export interface DexTradeRow {
  id: number;
  base_currency: string;
  base_issuer: string | null;
  counter_currency: string;
  counter_issuer: string | null;
  price: number;
  base_amount: string;
  counter_amount: string;
  taker: string;
  maker: string;
  ledger_index: number;
  close_time: number;
  tx_hash: string;
}

export type OhlcvPeriod = '1h' | '24h' | '7d';

export interface OhlcvCandleRow {
  id: number;
  base_currency: string;
  base_issuer: string | null;
  counter_currency: string;
  counter_issuer: string | null;
  period: OhlcvPeriod;
  open_time: number;
  open_ledger: number | null;
  close_ledger: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: string;
  trade_count: number;
}

export interface TokenListFilter {
  issuer?: string;
  currency?: string;
  domainVerified?: SqliteBool;
  q?: string;
  sort?: 'holder_count' | 'trust_count' | 'first_ledger';
  page: number;
  perPage: number;
}
