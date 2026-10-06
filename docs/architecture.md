# XahauIndex — Architecture

## Overview

XahauIndex has three layers: an **ingester** (snapshot + live WebSocket), a **SQLite database**, and a **Fastify API**. XahauIndex is an independent PuppyTools project — not affiliated with, endorsed by, or a product of the Xahau network or its operators. The XI mark is original artwork inspired by [Xahau/Graphics](https://github.com/Xahau/Graphics).

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
│  hooks.ts      — Hook install + HookDefinition metadata          │
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
│  Fastify API  :API_PORT/docs (from openapi.yaml) + /v1/…         │
└─────────────────────────────────────────────────────────────────┘
```

---

## Boot sequence

1. Open SQLite, run migrations, enable WAL + `busy_timeout`.
2. Connect `@transia/xrpl` `Client` to `XAHAUD_URL` (default mainnet).
3. If `indexer_state.snapshot_status` is not `complete`, run the snapshot.
4. Start the TOML worker and the URI metadata worker (icon URLs only).
5. Subscribe to `ledger` on `XAHAUD_URL` at the current tip. Live catch-up starts at the live node's `complete_ledgers` floor (or the tip if that range is unknown), not last-indexed + 1. Ignore live apply at or before `snapshot_ledger`.
6. If last-indexed is behind that floor, record a live gap and fill it forward on `BACKFILL_XAHAUD_URL` (or `XAHAUD_URL` if unset) with the same closed-ledger apply as live. Gap fill is paced (`BACKFILL_MIN_INTERVAL_MS`, default 2000ms) so a public history node is not exhausted. On a dedicated history URL, `BACKFILL_CONCURRENCY` (default 1, cap 32) prefetches that many ledgers, staggering fetch starts by the same interval, and applies them in ledger order. A units-quota `tooBusy` drops in-flight to 1 until fetches succeed again.
7. If `BACKFILL_FROM_DB` is set, bulk-import `ledger.db` + `transaction.db` (DEX trades + URIToken transfers) for the dump range up to `snapshot_ledger`. If `HISTORY_CATALOGUE` is set, stream that CATL file the same way. Resume via `history_db_next`. Then if `BACKFILL_FROM_LEDGER` or `BACKFILL_LOOKBACK` is set, walk closed ledgers `L..FROM` downward in history mode, jumping any range already imported from files. History fetches use the same dedicated URL as the gap fill. Missing historical ledgers are retried, then skipped.
8. Listen on `API_HOST:API_PORT`. No auth. If `API_RATE_LIMIT_MAX` is set, apply an in-process per-IP HTTP limit and a `/v1/subscribe` connection cap. `/docs` cookbook curls, endpoint Open links, and `/v1/openapi.yaml` use `API_BASE_URL` (default `http://localhost:3000` when unset). Project site: `https://xahauindex.dev`.

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
| `AccountRoot` | `issuers` (Domain / flags / later issuer), remarks |
| `Hook` | `hook_accounts`, `issuers.has_hooks` |
| `HookDefinition` | `hook_definitions` (hash, defaults, `code_size` — not WASM) |

### Live stream

- Reconnect with exponential backoff (1s → 60s).
- Subscribe at the current tip first so a short-history live node stays usable.
- Ledgers between last-indexed and the live node's `complete_ledgers` floor are a forward gap fill on the history node, not a live catch-up on `XAHAUD_URL`.
- After subscribe, catch up only the ledgers the live node still has, then apply newer `ledgerClosed` events.
- Process only validated `tesSUCCESS` transactions.
- One SQLite transaction per ledger.
- TOML HTTP is **never** inside that transaction.

### Historical backfill

Optional backward walk. After snapshot and after the live-gap fill:

- If `BACKFILL_FROM_DB=true`, open `HISTORY_LEDGER_DB` + `HISTORY_TX_DB` read-only (`ledger.db` / `transaction.db` from a **copy** of a full-history xahaud node — not NuDB, not a live WAL). Filter `Status='V'` and Offer/Payment/URIToken types, decode `RawTxn` + `TxnMeta` with `@transia/xrpl`, and call `applyHistoricalLedger` walking **forward**. Cap at `snapshot_ledger`. Resume `history_db_next`. Do not skip snapshot.
- If `HISTORY_CATALOGUE` is set, stream one xahaud CATL file (`catalogue_create`, magic `CATL`, zlib payload when the header compression nibble is > 0). Skip a ledger's state SHAMap when `accountHash` is unchanged from the previous ledger (xahaud writes **0 state bytes** in that case, not a TERMINAL). Decode `tnTRANSACTION_MD` leaves as VL(tx)+VL(meta), keep Offer/Payment/URIToken types, `applyHistoricalLedger`. SHA-512 header verification is not done in v1. Do not `catalogue_load` the file into xahaud. One path per start; a later file whose range is not already inside the completed union extends `history_db_from`/`history_db_through`. Cap at `snapshot_ledger`. Snapshot is still required — catalogues do not replace current-state ingest.
- Then if `BACKFILL_FROM_LEDGER` (alias `FULL_HISTORY_START`; `genesis`/`start` → `1`) or `BACKFILL_LOOKBACK` is set, walk `snapshot_ledger` down to `FROM` inclusive. Ledgers already imported from files are not refetched.

- The live gap (last indexed → subscribe tip) is filled first, even when no backward bound is set.
- File import runs in the backfill worker after the live gap, in parallel with live follow.
- Recent RPC history is filled first. `genesis` keeps decrementing until ledger 1, jumping the dump range.
- `FROM` wins when both RPC bounds are set. Neither set = no RPC walk (file import can still run).
- History mode writes DEX trades (idempotent) and URIToken transfers. If the URIToken already exists from the snapshot, owner/offer/burn are left alone.
- Missing tokens get a full apply, then a burn when the node is a `DeletedNode`.
- RippleState, AccountRoot, SetRemarks, and SetHook are not applied.
- Public nodes that cannot serve an old ledger: retry, then skip and persist `backfill_next`.
- Sharing the live websocket paces fetches (`BACKFILL_MIN_INTERVAL_MS`, default 2000ms), gives live the shared quota first, and pauses backfill after `tooBusy` so both workers do not retry the same window. Rate-limit errors wait for the hinted retry and never skip a ledger or tear down live subscribe.
- Optional dedicated history node (`BACKFILL_XAHAUD_URL`, or `XAHAUD_URL` inside `BACKFILL_ENV` / `.env.backfill`) so live subscribe can stay on a short-history websocket. `http`/`https` uses JSON-RPC `ledger`; `ws`/`wss` uses the same client as live. `BACKFILL_CONCURRENCY` (default 1, cap 32) overlaps in-flight fetches on that dedicated node only — one client, not extra processes. Fetch starts are staggered by `BACKFILL_MIN_INTERVAL_MS`. Sharing `XAHAUD_URL` stays at concurrency 1. A `tooBusy` / units-quota 429 forces 1 in-flight until a few fetches succeed. Apply is still newest-first (backward) or oldest-first (gap fill) on a single SQLite writer.
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

The URI field is a 256-byte on-ledger blob. It may be an `https` / `ipfs` link, or packed application data (Evernode lease tokens start as hex that decodes to base64 `evrleaseLTV…`). The API sets `uri_kind` and fills `metadata` from fetched HTTPS JSON when the URI is a document URL. If the URI is not a URL, `metadata` is decoded at read time (`source: onchain`) so existing tokens are viewable without a refetch. Remarks remain a separate `SetRemarks` map.

### Remarks

Shared decoder. Hex name/value → UTF-8. JSON values stored as TEXT. Missing value deletes the key. `Flags & 1` = immutable.

Primary key is `(object_id, name)` where `object_id` is the 64-char ledger object index (`SetRemarks.ObjectID`). Denormalize `uri_token_id`, `account`, and `token_id` for API joins.

v1 first-class types: `URIToken`, `AccountRoot`, `RippleState`. Other `SetRemarks` targets are stored but not exposed on resource endpoints.

Well-known keys (`name`, `description`, `image`, `icon`, `website`, `attributes`, …) also populate display columns on tokens / URITokens when those columns are empty or last written from remarks.

### Hooks

Installed hooks are a `Hook` ledger object ([Xahau Hook](https://xahau.network/docs/protocol-reference/ledger-data/ledger-objects-types/hook/)): `Account` plus a `Hooks` array of `{ Hook: { HookHash, … } }` slots. The bytecode and defaults live on a reference-counted `HookDefinition` ([docs](https://xahau.network/docs/protocol-reference/ledger-data/ledger-objects-types/hook-definition/)). Snapshot indexes both from `ledger_data`. Live `SetHook` creates / replaces / deletes them. Store `code_size`, not `CreateCode`. `AccountRoot` does not carry the hook array. HookOn bitmasks are decoded to `triggers` (`all_except` / `only` / `none`) at read time. Empty slots are dropped. `label` is applied at read time from `src/util/hookLabels.ts`: hash first, then the four stable Evernode accounts if governance rotated the WASM. Do not invent hashes — update the catalog from a live `account_objects type=hook` read.

### Issuers + TOML

`account_info` → Domain hex (printable hostname only) → `https://<domain>/.well-known/xahau.toml` ([Xahau identity spec](https://xahau.network/docs/infrastructure/identity/)). Never fetch `xrp-ledger.toml`. Hex blobs and non-hostnames are stored if printable but never fetched. Verified if the r-address appears in `[[ACCOUNTS]]` or `[[CURRENCIES]]` (custom `[[ISSUERS]]` / `[[TOKENS]]` in the same xahau.toml also count). Re-check ~every 1000 ledgers and on Domain-changing `AccountSet`. Token issuers are checked before host-only domains. Expected fetch misses (NXDOMAIN, timeout, 404, HTML stand-in, bad cert) are debug; a pass summary is info. Fetches send a product User-Agent so Cloudflare-backed sites can serve the file. Socials come from `[ORGANIZATION]` / `[[PRINCIPALS]]` (`website`, `x`, `social_*`) plus any custom `[[WEBLINKS]]` in that file.

HTTPS only, timeout, size cap, no private-IP redirects.

**Blackholed:** `lsfDisableMaster` and (no RegularKey or RegularKey in the known blackhole set).

### Icons

The API returns `icon_url` / `toml_icon_url` strings and `toml_links` (`url`, `type`, `title`). Sources: on-ledger remarks (`image` / `icon` / `icon_url` / `website`), issuer TOML `icon`, `[[WEBLINKS]]` / `[[TOKENS.WEBLINKS]]` / `[[TOKENS.URLS]]`, and `[ORGANIZATION]` website/twitter. Token `website_url` is filled from the first website link when empty. Image bytes are never downloaded for storage or proxied. `data:` URIs are discarded. When a URIToken URI is HTTPS JSON metadata, that JSON is stored on the token as `metadata`.

### DEX

Extract executed takes from `OfferCreate` / `OfferDelete` / auto-bridge `Payment` metadata. Insert `dex_trades`. Upsert calendar candles for `1h`, `24h`, `7d`.

Alignment is UTC:

- `1h` — `floor(ts/3600)*3600`
- `24h` — UTC day
- `7d` — Unix-epoch week (`floor(ts/604800)*604800`)

Price is **counter per base**. Pair sides are stored in lexicographic `(currency+issuer)` order so `USD/XAH` and `XAH/USD` are one pair. XAH issuer is `NULL`.

`PriceSummary.change_24h` / `volume_24h` are derived at read time, not stored as rolling rows.

History begins at the backfill frontier (`backfill_ledger` while walking down, `backfill_from` when complete), otherwise `live_from_ledger`. Range filters apply to whatever the node has collected. Historical apply never rewrites snapshot token balances.

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

Keys: `snapshot_status`, `snapshot_ledger`, `snapshot_marker`, `live_from_ledger`, `backfill_status`, `backfill_from`, `backfill_through`, `backfill_next`, `backfill_ledger`, `backfill_direction`, `history_db_status`, `history_db_from`, `history_db_through`, `history_db_next`, `history_db_ledger`, `history_catalogue_path`, `network_id`.

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
  toml_links        TEXT,
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

### `hook_definitions`

```sql
CREATE TABLE hook_definitions (
  hook_hash         TEXT PRIMARY KEY,
  hook_namespace    TEXT,
  hook_on           TEXT,
  hook_on_incoming  TEXT,
  hook_on_outgoing  TEXT,
  hook_can_emit     TEXT,
  hook_name         TEXT,
  hook_api_version  INTEGER,
  parameters_json   TEXT NOT NULL DEFAULT '[]',
  reference_count   INTEGER,
  code_size         INTEGER NOT NULL DEFAULT 0,
  hook_fee          TEXT,
  hook_callback_fee TEXT,
  hook_set_txn_id   TEXT,
  flags             INTEGER,
  first_ledger      INTEGER NOT NULL,
  last_updated      INTEGER NOT NULL
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

`/docs`, `/docs/cookbook.md`, and the README cookbook section are generated from `docs/openapi.yaml` (`x-docs`, `x-cookbook`, and response `examples`). Run `npm run docs:sync` after editing the spec.

### Identifiers

- Token: `/v1/tokens/{currency}/{issuer}`
- Pair: `/v1/prices/{base}/{counter}?base_issuer=&counter_issuer=`
- Trades for one asset: `/v1/trades/{currency}` (`issuer` / `base_issuer` when not XAH)
- Native currency code: `XAH`

### Pagination

List endpoints: `?page=1&per_page=20` (max 250).

Price/trade range: `from`, `to` (unix seconds), `from_ledger`, `to_ledger`, `limit` (max 1000). If both time and ledger ranges are set, both constraints apply (AND). Without a range, return the latest `limit` rows.

### WebSocket

`/v1/subscribe` is not xahaud WebSocket `subscribe`. A public or self-hosted xahaud socket (`ledger`, `transactions`, books) is the raw firehose. This endpoint pushes the same enriched objects as REST after ingest — token updates, URIToken lifecycle, DEX trades, hook installs — so a wallet or DEX does not re-index that firehose.

Client:

```json
{ "command": "subscribe", "streams": ["tokens", "uritokens", "prices", "hooks"] }
```

Server:

```json
{ "stream": "uritokens", "event": "mint", "data": {} }
```

Streams: `tokens`, `uritokens`, `prices`, `hooks`.

### Operator rate limiting

Optional. Off unless `API_RATE_LIMIT_MAX` is a positive integer. Still no API keys.

- Key is `request.ip`. `API_TRUST_PROXY` must stay false on a public bind so clients cannot spoof `X-Forwarded-For`.
- Same HTTP bucket for REST, unknown routes, and the WebSocket upgrade. `/`, `/docs`, `/docs/*`, and `/v1/openapi.yaml` are excluded so browsing the docs page does not consume the quota.
- Over limit: `429` `{ error: { code: "RATE_LIMITED", message: "Too many requests" } }` plus `Retry-After`.
- `API_WS_MAX_PER_IP` caps concurrent `/v1/subscribe` sockets per IP (default 8 when the HTTP limiter is on).
- In-memory only. Ingest / snapshot / xahaud quota are separate.

---

## Key design decisions

**Why a snapshot instead of live-only?** Wallets, explorers, and DEX UIs need current holder/supply/ownership/hook state. Live-only is empty until objects move. Snapshot is the current-state gate; optional backfill adds historical trades and URIToken transfers without touching those balances.

**Why SQLite?** Zero-dependency self-hosting. Xahau throughput fits a single-writer file. Postgres can wait for v3.

**Why `@transia/xrpl`?** Official `xrpl` does not model URIToken / SetHook / SetRemarks. The Transia fork is the Xahau client. We still own our types.

**Why two-segment URLs?** `:` and `+` are unsafe or ambiguous in URIs. `/USD/r…` is unambiguous.

**Why calendar candles, not rolling windows?** Range queries (`from`/`to`, ledger indexes) need stored buckets. 24h change is computed at read time.

**Why not fork xrplmeta?** Its model is IOU/MPT/XLS-20. URITokens, Hooks, Remarks, and snapshot-on-Xahau would replace most of the ingester anyway.
