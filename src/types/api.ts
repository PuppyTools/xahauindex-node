export interface Meta {
  count?: number;
  page?: number;
  per_page?: number;
  ledger_index: number;
  history_start_ledger?: number;
}

export interface Envelope<T> {
  data: T;
  meta: Meta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
  };
}

export type SnapshotStatus = 'pending' | 'running' | 'complete';
export type BackfillStatus = 'idle' | 'running' | 'complete';
export type IndexerHealth = 'syncing' | 'live' | 'degraded';

export interface Status {
  status: IndexerHealth;
  snapshot_status: SnapshotStatus;
  snapshot_ledger: number | null;
  history_start_ledger: number | null;
  backfill_status: BackfillStatus;
  backfill_from: number | null;
  backfill_ledger: number | null;
  ledger_index: number;
  network_ledger_index: number | null;
  lag_ledgers: number | null;
  indexed_ledgers: number;
  token_count: number;
  uri_token_count: number;
  issuer_count: number;
  uptime_seconds: number;
}

export type RemarksMap = Record<string, string>;

export interface TomlLink {
  url: string;
  type: string | null;
  title: string | null;
}

export interface Token {
  id: string;
  currency: string;
  currency_hex: string | null;
  issuer: string;
  name: string | null;
  description: string | null;
  icon_url: string | null;
  website_url: string | null;
  toml_links: TomlLink[];
  supply: string | null;
  holder_count: number;
  trust_count: number;
  domain_verified: boolean;
  blackholed: boolean;
  first_ledger: number;
  last_updated: number;
  remarks?: RemarksMap;
}

export interface PriceSummary {
  price: number;
  change_24h: number | null;
  volume_24h: string | null;
  high_24h: number | null;
  low_24h: number | null;
}

export interface Issuer {
  account: string;
  domain: string | null;
  domain_verified: boolean;
  email_hash: string | null;
  transfer_rate: number | null;
  flags: number | null;
  blackholed: boolean;
  toml_name: string | null;
  toml_description: string | null;
  toml_icon_url: string | null;
  toml_links: TomlLink[];
  has_hooks: boolean;
  token_count?: number;
  first_ledger: number;
  last_updated: number;
  remarks?: RemarksMap;
}

export interface TokenDetail extends Token {
  issuer_profile?: Issuer;
  price?: PriceSummary | null;
}

export interface TrustLine {
  account: string;
  currency: string;
  issuer: string;
  balance: string;
  limit_peer: string;
  flags: number | null;
  remarks?: RemarksMap;
}

export type UriKind = 'https' | 'ipfs' | 'image' | 'onchain' | 'empty';

export interface URIToken {
  id: string;
  uri: string | null;
  uri_raw: string;
  uri_kind: UriKind;
  digest: string | null;
  issuer: string;
  owner: string;
  flags: number | null;
  sell_offer: string | Record<string, string> | null;
  destination: string | null;
  burned: boolean;
  burn_ledger: number | null;
  mint_ledger: number;
  last_updated: number;
  icon_url: string | null;
  metadata: unknown | null;
  remarks?: RemarksMap;
  transfer_count?: number;
}

export interface URITokenTransfer {
  from_account: string;
  to_account: string;
  price: string | null;
  ledger_index: number;
  tx_hash: string;
}

export interface URITokenDetail extends URIToken {
  transfers?: URITokenTransfer[];
}

export interface HookParameter {
  name?: string;
  value?: string;
}

export interface HookGrant {
  account?: string;
  hook_hash?: string;
}

export interface HookTriggerMask {
  raw: string;
  mode: 'all_except' | 'only' | 'none';
  types: string[];
}

export interface HookDefinition {
  hook_hash: string;
  hook_namespace?: string | null;
  hook_on?: string | null;
  hook_on_incoming?: string | null;
  hook_on_outgoing?: string | null;
  hook_can_emit?: string | null;
  hook_name?: string | null;
  hook_api_version?: number | null;
  parameters?: HookParameter[];
  reference_count?: number | null;
  code_size: number;
  hook_fee?: string | null;
  hook_callback_fee?: string | null;
  hook_set_txn_id?: string | null;
  flags?: number | null;
  triggers?: HookTriggerMask | null;
  triggers_incoming?: HookTriggerMask | null;
  triggers_outgoing?: HookTriggerMask | null;
  can_emit?: HookTriggerMask | null;
  first_ledger?: number;
  last_updated?: number;
}

export interface HookEntry {
  hook_hash: string;
  hook_on?: string | null;
  hook_on_incoming?: string | null;
  hook_on_outgoing?: string | null;
  hook_can_emit?: string | null;
  hook_namespace?: string | null;
  hook_name?: string | null;
  hook_api_version?: number | null;
  parameters?: HookParameter[];
  grants?: HookGrant[];
  triggers?: HookTriggerMask | null;
  triggers_incoming?: HookTriggerMask | null;
  triggers_outgoing?: HookTriggerMask | null;
  can_emit?: HookTriggerMask | null;
  definition?: HookDefinition | null;
}

export interface HookState {
  account: string;
  hook_count: number;
  hooks: HookEntry[];
  first_ledger?: number;
  last_updated?: number;
}

export interface IssuerDetail extends Issuer {
  tokens?: Token[];
  hooks?: HookState | null;
}

export interface OHLCVCandle {
  open_time: number;
  open_ledger?: number | null;
  close_ledger?: number | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: string;
  trade_count: number;
}

export interface DexTrade {
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
