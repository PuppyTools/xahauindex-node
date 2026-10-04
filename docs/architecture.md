# XahauIndex — Architecture

## Overview

XahauIndex has three layers: an **ingester** (snapshot + live WebSocket), a **SQLite database**, and a **Fastify API**.

```
┌─────────────────────────────────────────────────────────────────┐
│  xahaud node  (wss://xahau.network or self-hosted)              │
└─────────────┬───────────────────────────────────┬───────────────┘
              │ ledger_data (first boot)          │ WS ledger + tx
              ▼                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Ingester  (src/ingester/)                                       │
│  snapshot.ts   — page current validated ledger                   │
│  ledger.ts     — one SQLite transaction per closed ledger        │
│  tokens.ts     — RippleState / TrustSet / IOU Payment            │
│  uritokens.ts  — URIToken mint/burn/offer/buy                    │
│  hooks.ts      — AccountRoot Hook array                          │
│  remarks.ts    — Remarks decode + SetRemarks                     │
│  issuers.ts    — AccountRoot + TOML (async worker)               │
│  dex.ts        — executed offers → trades + calendar candles     │
└──────────────────────────┬──────────────────────────────────────┘
                           │  better-sqlite3
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  SQLite  (DB_PATH, default ./data/xahauindex.db)                 │
└──────────────────────────┬──────────────────────────────────────┘
                           │  reads
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Fastify API  :API_PORT/v1/…   WS /v1/subscribe                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Boot sequence

1. Open SQLite, run migrations, enable WAL + `busy_timeout`.
2. Connect `@transia/xrpl` `Client` to `XAHAUD_URL` (default mainnet).
3. If `indexer_state.snapshot_status` is not `complete`, run the snapshot.
4. Start the TOML worker and the URI metadata worker (icon URLs only).
5. If `BACKFILL_FROM_LEDGER` or `BACKFILL_LOOKBACK` is set, walk closed ledgers `FROM..L` in history mode (DEX trades + URIToken transfers only). History fetches use `BACKFILL_XAHAUD_URL` or a second env file (`BACKFILL_ENV` / `.env.backfill`) when set, otherwise `XAHAUD_URL`. Resume via `backfill_next`. Missing historical ledgers are retried, then skipped.
6. Subscribe to `ledger`. Ignore live apply at or before `snapshot_ledger`. Live starts at `max(MAX(ledgers)+1, live_from_ledger)` and never below `L+1`.
7. Listen on `API_HOST:API_PORT`. No auth.

### Snapshot

Target: the current **validated** ledger `L`.

- Request `ledger_data` with `ledger_index: L`, follow `marker`.
- Persist `snapshot_ledger`, `snapshot_marker`, `snapshot_status=running` after every page.
- Crash resume uses the same `L` and marker while that ledger is still available.
- If the node returns `ledgerNotFound` / `lgrNotFound` for `L` (public history window expired, or a load-balanced backend dropped it), reconnect and retry. If `L` is still gone and the current validated tip has moved, wipe the incomplete snapshot tables and retarget to the new tip. Do not mix objects from two snapshot ledgers.
- After the last page: recompute token aggregates, enqueue TOML jobs, set `live_from_ledger = L+1`, `snapshot_status=complete`.

Objects consumed during snapshot:

| Type | Writes |
|------|--------|
| `RippleState` | `trust_lines`, parent `tokens` / `issuers`, remarks |
| `URIToken` | `uri_tokens`, remarks |
| `AccountRoot` | `issuers` (Domain / flags / later issuer), `hook_accounts`, remarks |

### Live stream

- Reconnect with exponential backoff (1s → 60s).
- On a gap, fill with `ledger` (`transactions: true`) before applying newer stream events.
- Process only validated `tesSUCCESS` transactions.
- One SQLite transaction per ledger.
- TOML HTTP is **never** inside that transaction.

### Historical backfill

Optional. After snapshot, if `BACKFILL_FROM_LEDGER` (alias `FULL_HISTORY_START`; `genesis`/`start` → `1`) or `BACKFILL_LOOKBACK` is set, walk `FROM..snapshot_ledger` inclusive.

- `FROM` wins when both are set. Neither set = no backfill.
- History mode writes DEX trades (idempotent) and URIToken transfers. If the URIToken already exists from the snapshot, owner/offer/burn are left alone.
- Missing tokens get a full apply, then a burn when the node is a `DeletedNode`.
- RippleState, AccountRoot, SetRemarks, and SetHook are not applied.
- Public nodes that cannot serve an old ledger: retry, then skip and persist `backfill_next`.
- Optional dedicated history node (`BACKFILL_XAHAUD_URL`, or `XAHAUD_URL` inside `BACKFILL_ENV` / `.env.backfill`) so live subscribe can stay on a short-history websocket. `http`/`https` uses JSON-RPC `ledger`; `ws`/`wss` uses the same client as live.
- Runs in parallel with live follow. Historical rows below `L` do not move `MAX(ledgers)` past the snapshot.

---

## Domain handlers

### Tokens

`TrustSet`, IOU `Payment`, issuer `AccountSet`, plus snapshot RippleState.

- `holder_count` — accounts with non-zero balance, excluding the issuer
- `trust_count` — all lines
- `supply` — absolute issuer-side obligation, decimal string

### URITokens

`URITokenMint`, `URITokenBurn`, `URITokenCreateSellOffer`, `URITokenCancelSellOffer`, `URITokenBuy`, and `SetRemarks` targeting a URIToken.

`Amount` + `Destination` on the object are the active sell offer. Burned tokens stay in the table with `burned=1` (live only; snapshot cannot see already-burned tokens).

### Remarks

Shared decoder. Hex name/value → UTF-8. JSON values stored as TEXT. Missing value deletes the key. `Flags & 1` = immutable.

Primary key is `(object_id, name)` where `object_id` is the 64-char ledger object index (`SetRemarks.ObjectID`). Denormalize `uri_token_id`, `account`, and `token_id` for API joins.

v1 first-class types: `URIToken`, `AccountRoot`, `RippleState`. Other `SetRemarks` targets are stored but not exposed on resource endpoints.

Well-known keys (`name`, `description`, `image`, `icon`, `website`, `attributes`, …) also populate display columns on tokens / URITokens when those columns are empty or last written from remarks.

### Hooks

`SetHook` replaces the stored array for that account. Persist HookOn v1 and v2 fields when present.

### Issuers + TOML

`account_info` → Domain hex → `https://<domain>/.well-known/xrp-ledger.toml`. Verified if the r-address appears in `[[ACCOUNTS]]`. Re-check ~every 1000 ledgers and on Domain-changing `AccountSet`.

HTTPS only, timeout, size cap, no private-IP redirects.

**Blackholed:** `lsfDisableMaster` and (no RegularKey or RegularKey in the known blackhole set).

### Icons

The API returns `icon_url` / `toml_icon_url` strings. Sources: on-ledger remarks (`image` / `icon` / `icon_url`), issuer TOML `icon` (copied onto tokens that have no icon), and optional HTTPS fetch of a URIToken `uri` when it is JSON metadata. If the URI itself looks like an image, that URI is stored. When the URI is a JSON metadata document, the parsed JSON is stored on the URIToken as `metadata`. Image bytes are never downloaded for storage or proxied. `data:` URIs are discarded.

### DEX

Extract executed takes from `OfferCreate` / `OfferDelete` / auto-bridge `Payment` metadata. Insert `dex_trades`. Upsert calendar candles for `1h`, `24h`, `7d`.

Alignment is UTC:

- `1h` — `floor(ts/3600)*3600`
- `24h` — UTC day
- `7d` — Unix-epoch week (`floor(ts/604800)*604800`)

Price is **counter per base**. Pair sides are stored in lexicographic `(currency+issuer)` order so `USD/XAH` and `XAH/USD` are one pair. XAH issuer is `NULL`.

`PriceSummary.change_24h` / `volume_24h` are derived at read time, not stored as rolling rows.

History begins at `backfill_from` when a backfill is configured, otherwise `live_from_ledger`. Range filters apply to whatever the node has collected. Historical apply never rewrites snapshot token balances.

---

## Database schema

All migrations live in `src/db/migrations/`. Never edit an existing migration; add a new numbered file. Greenfield v1 ships as `001_init.sql`.

### `indexer_state`

```sql
CREATE TABLE indexer_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
```

Keys: `snapshot_status`, `snapshot_ledger`, `snapshot_marker`, `live_from_ledger`, `backfill_status`, `backfill_from`, `backfill_through`, `backfill_next`, `backfill_ledger`, `network_id`.

### `ledgers`

```sql
CREATE TABLE ledgers (
  ledger_index  INTEGER PRIMARY KEY,
  close_time    INTEGER NOT NULL,
  hash          TEXT NOT NULL,
  tx_count      INTEGER NOT NULL DEFAULT 0,
  indexed_at    INTEGER NOT NULL
);
```

### `tokens`

```sql
CREATE TABLE tokens (
  id              TEXT PRIMARY KEY,  -- "<currency>:<issuer>"
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
```

### `trust_lines`

```sql
CREATE TABLE trust_lines (
  id            TEXT PRIMARY KEY,  -- "<account>:<currency>:<issuer>"
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
```

### `issuers`

```sql
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
```

### `uri_tokens`

```sql
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
  mint_ledger              INTEGER NOT NULL,
  last_updated             INTEGER NOT NULL,
  icon_url                 TEXT,
  uri_metadata             TEXT,
  uri_meta_checked_ledger  INTEGER
);
CREATE INDEX uri_tokens_issuer ON uri_tokens(issuer);
CREATE INDEX uri_tokens_owner ON uri_tokens(owner);
CREATE INDEX uri_tokens_burned ON uri_tokens(burned);
```

### `uri_token_transfers`

```sql
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
```

### `remarks`

```sql
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
```

### `hook_accounts`

```sql
CREATE TABLE hook_accounts (
  account       TEXT PRIMARY KEY,
  hook_count    INTEGER NOT NULL DEFAULT 0,
  hooks_json    TEXT NOT NULL,
  first_ledger  INTEGER NOT NULL,
  last_updated  INTEGER NOT NULL
);
```

### `dex_trades`

```sql
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
```

### `ohlcv_candles`

```sql
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
  UNIQUE(
    base_currency, base_issuer, counter_currency, counter_issuer, period, open_time
  )
);
CREATE INDEX ohlcv_pair_period ON ohlcv_candles(
  base_currency, base_issuer, counter_currency, counter_issuer, period, open_time DESC
);
```

---

## API layer

### Response envelope

```json
{
  "data": {},
  "meta": {
    "count": 42,
    "page": 1,
    "per_page": 20,
    "ledger_index": 9241832
  }
}
```

```json
{ "error": { "code": "NOT_FOUND", "message": "Token USD/rHb9… not found" } }
```

### Identifiers

- Token: `/v1/tokens/{currency}/{issuer}`
- Pair: `/v1/prices/{base}/{counter}?base_issuer=&counter_issuer=`
- Native currency code: `XAH`

### Pagination

List endpoints: `?page=1&per_page=20` (max 100).

Price/trade range: `from`, `to` (unix seconds), `from_ledger`, `to_ledger`, `limit` (max 500). If both time and ledger ranges are set, both constraints apply (AND). Without a range, return the latest `limit` rows.

### WebSocket

Client:

```json
{ "command": "subscribe", "streams": ["tokens", "uritokens", "prices", "hooks"] }
```

Server:

```json
{ "stream": "uritokens", "event": "mint", "data": {} }
```

Streams: `tokens`, `uritokens`, `prices`, `hooks`.

---

## Key design decisions

**Why a snapshot instead of live-only?** Wallets, explorers, and DEX UIs need current holder/supply/ownership/hook state. Live-only is empty until objects move. Snapshot is the current-state gate; optional backfill adds historical trades and URIToken transfers without touching those balances.

**Why SQLite?** Zero-dependency self-hosting. Xahau throughput fits a single-writer file. Postgres can wait for v3.

**Why `@transia/xrpl`?** Official `xrpl` does not model URIToken / SetHook / SetRemarks. The Transia fork is the Xahau client. We still own our types.

**Why two-segment URLs?** `:` and `+` are unsafe or ambiguous in URIs. `/USD/r…` is unambiguous.

**Why calendar candles, not rolling windows?** Range queries (`from`/`to`, ledger indexes) need stored buckets. 24h change is computed at read time.

**Why not fork xrplmeta?** Its model is IOU/MPT/XLS-20. URITokens, Hooks, Remarks, and snapshot-on-Xahau would replace most of the ingester anyway.
