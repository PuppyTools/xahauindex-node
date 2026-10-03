CREATE TABLE indexer_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE ledgers (
  ledger_index  INTEGER PRIMARY KEY,
  close_time    INTEGER NOT NULL,
  hash          TEXT NOT NULL,
  tx_count      INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);

CREATE TABLE issuers (
  account           TEXT PRIMARY KEY,
  domain            TEXT,
  domain_verified   INTEGER NOT NULL DEFAULT 0,
  email_hash        TEXT,
  transfer_rate     INTEGER,
  flags             INTEGER,
  blackholed        INTEGER NOT NULL DEFAULT 0,
  toml_name         TEXT,
  toml_description  TEXT,
  toml_icon_url     TEXT,
  toml_raw          TEXT,
  has_hooks         INTEGER NOT NULL DEFAULT 0,
  first_ledger      INTEGER NOT NULL,
  last_updated      INTEGER NOT NULL
);

CREATE TABLE tokens (
  id              TEXT PRIMARY KEY,
  currency        TEXT NOT NULL,
  currency_hex    TEXT,
  issuer          TEXT NOT NULL,
  name            TEXT,
  description     TEXT,
  icon_url        TEXT,
  website_url     TEXT,
  supply          TEXT,
  holder_count    INTEGER NOT NULL DEFAULT 0,
  trust_count     INTEGER NOT NULL DEFAULT 0,
  domain_verified INTEGER NOT NULL DEFAULT 0,
  blackholed      INTEGER NOT NULL DEFAULT 0,
  first_ledger    INTEGER NOT NULL,
  last_updated    INTEGER NOT NULL,
  FOREIGN KEY (issuer) REFERENCES issuers(account)
);

CREATE INDEX tokens_issuer ON tokens(issuer);
CREATE INDEX tokens_holder_count ON tokens(holder_count DESC);

CREATE TABLE trust_lines (
  id            TEXT PRIMARY KEY,
  account       TEXT NOT NULL,
  currency      TEXT NOT NULL,
  issuer        TEXT NOT NULL,
  balance       TEXT NOT NULL,
  limit_peer    TEXT NOT NULL,
  quality_in    INTEGER,
  quality_out   INTEGER,
  flags         INTEGER,
  first_ledger  INTEGER NOT NULL,
  last_updated  INTEGER NOT NULL
);

CREATE INDEX trust_lines_token ON trust_lines(currency, issuer);
CREATE INDEX trust_lines_account ON trust_lines(account);

CREATE TABLE uri_tokens (
  id            TEXT PRIMARY KEY,
  uri           TEXT,
  uri_raw       TEXT NOT NULL,
  digest        TEXT,
  issuer        TEXT NOT NULL,
  owner         TEXT NOT NULL,
  flags         INTEGER,
  sell_offer    TEXT,
  destination   TEXT,
  burned        INTEGER NOT NULL DEFAULT 0,
  burn_ledger   INTEGER,
  mint_ledger   INTEGER NOT NULL,
  last_updated  INTEGER NOT NULL
);

CREATE INDEX uri_tokens_issuer ON uri_tokens(issuer);
CREATE INDEX uri_tokens_owner ON uri_tokens(owner);
CREATE INDEX uri_tokens_burned ON uri_tokens(burned);

CREATE TABLE uri_token_transfers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uri_token_id  TEXT NOT NULL,
  from_account  TEXT NOT NULL,
  to_account    TEXT NOT NULL,
  price         TEXT,
  ledger_index  INTEGER NOT NULL,
  tx_hash       TEXT NOT NULL,
  FOREIGN KEY (uri_token_id) REFERENCES uri_tokens(id)
);

CREATE INDEX uri_token_transfers_token ON uri_token_transfers(uri_token_id);

CREATE TABLE remarks (
  object_id     TEXT NOT NULL,
  object_type   TEXT NOT NULL,
  name          TEXT NOT NULL,
  value         TEXT NOT NULL,
  immutable     INTEGER NOT NULL DEFAULT 0,
  uri_token_id  TEXT,
  account       TEXT,
  token_id      TEXT,
  last_updated  INTEGER NOT NULL,
  PRIMARY KEY (object_id, name)
);

CREATE INDEX remarks_uri_token ON remarks(uri_token_id);
CREATE INDEX remarks_account ON remarks(account);
CREATE INDEX remarks_token ON remarks(token_id);
CREATE INDEX remarks_type ON remarks(object_type);

CREATE TABLE hook_accounts (
  account       TEXT PRIMARY KEY,
  hook_count    INTEGER NOT NULL DEFAULT 0,
  hooks_json    TEXT NOT NULL,
  first_ledger  INTEGER NOT NULL,
  last_updated  INTEGER NOT NULL
);

CREATE TABLE dex_trades (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  base_currency    TEXT NOT NULL,
  base_issuer      TEXT,
  counter_currency TEXT NOT NULL,
  counter_issuer   TEXT,
  price            REAL NOT NULL,
  base_amount      TEXT NOT NULL,
  counter_amount   TEXT NOT NULL,
  taker            TEXT NOT NULL,
  maker            TEXT NOT NULL,
  ledger_index     INTEGER NOT NULL,
  close_time       INTEGER NOT NULL,
  tx_hash          TEXT NOT NULL
);

CREATE INDEX dex_trades_pair ON dex_trades(
  base_currency, base_issuer, counter_currency, counter_issuer, close_time
);
CREATE INDEX dex_trades_pair_ledger ON dex_trades(
  base_currency, base_issuer, counter_currency, counter_issuer, ledger_index
);

CREATE TABLE ohlcv_candles (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  base_currency    TEXT NOT NULL,
  base_issuer      TEXT,
  counter_currency TEXT NOT NULL,
  counter_issuer   TEXT,
  period           TEXT NOT NULL,
  open_time        INTEGER NOT NULL,
  open_ledger      INTEGER,
  close_ledger     INTEGER,
  open             REAL NOT NULL,
  high             REAL NOT NULL,
  low              REAL NOT NULL,
  close            REAL NOT NULL,
  volume           TEXT NOT NULL,
  trade_count      INTEGER NOT NULL,
  base_issuer_key TEXT GENERATED ALWAYS AS (ifnull(base_issuer, '')) STORED,
  counter_issuer_key TEXT GENERATED ALWAYS AS (ifnull(counter_issuer, '')) STORED,
  UNIQUE(
    base_currency,
    base_issuer_key,
    counter_currency,
    counter_issuer_key,
    period,
    open_time
  )
);

CREATE INDEX ohlcv_pair_period ON ohlcv_candles(
  base_currency, base_issuer, counter_currency, counter_issuer, period, open_time DESC
);
