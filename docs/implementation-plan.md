# XahauIndex v1 — Implementation Plan

This is the build plan. `docs/architecture.md` is the data-model source of truth. `docs/openapi.yaml` is the API contract. `CURSOR.md` is the session rulebook.

Do not start coding against the original attached drafts. Those drafts are superseded by the decisions below.

---

## 1. Decision log

| # | Decision | Choice |
|---|----------|--------|
| 1 | First-boot data | **Current-ledger snapshot**, then live ingest from `snapshot_ledger + 1`. No historical transaction backfill in v1. |
| 2 | Ledger client | **`@transia/xrpl`** (Xahau-aware). Still define our own ledger-object types; do not blindly trust upstream shapes. |
| 3 | Prices | **Historical calendar candles** plus `from`/`to` time and `from_ledger`/`to_ledger` range filters. |
| 4 | Remarks | Index remarks on **URITokens, issuer AccountRoots, and issuer-side trust lines**. Ingest `SetRemarks`. |
| 5 | URL identifiers | **Two path segments**, never `:` or `+` in a single token. Example: `/v1/tokens/USD/rHb9…`. |
| 6 | Consumers | Wallet, explorer, and DEX UI share one accurate dataset. Snapshot + strict aggregates are launch requirements. |
| 7 | Network | **Xahau mainnet** (`wss://xahau.network`). Testnet is an override, not the default. |
| 8 | Blackholed | Master key disabled **and** RegularKey absent or a known blackhole address. |
| 9 | Auth | **No API key.** Bind `0.0.0.0:3000`, open CORS. Operators reverse-proxy if they want TLS or ACLs. |
| 10 | Delivery | Plan first, then Phase 0–1 skeleton on `cursor/v1-skeleton-5c2e`. |

### Still out of v1

- Full transaction history / genesis backfill
- Auth, API keys (operator IP rate limiting is optional env, still no keys)
- Governance Game
- Cross-chain bridges
- Icon CDN / image byte cache (Bithomp, Xaman, URI HTTP image fetch). Icon *URLs* from remarks, TOML, and URI metadata JSON are in scope.
- Multi-node federation
- Postgres adapter

Price **depth** starts at the first live ledger after snapshot. The range API exists from day one; candles accumulate forward. Bounded trade backfill is v1.1.

---

## 2. What “accurate enough for all three consumers” means

| Consumer | Needs from v1 |
|----------|----------------|
| Wallet | Token list with name/icon/verified/blackholed; URIToken ownership + remarks; issuer profile; hook presence |
| Explorer | Holder lists, trust lines, URIToken transfers, issuer remarks, hook hashes, sync status / lag |
| DEX UI | Trade tape, OHLCV with time or ledger range, 24h change/volume |

That implies endpoints the original draft omitted: **holders**, **trades**, and **range-queryable candles**. They are in v1.

---

## 3. Stack (locked)

| Concern | Choice |
|---------|--------|
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess`, no `any` |
| Runtime | Node.js 20+ ESM |
| Build | `tsc` → `dist/` |
| DB | SQLite via `better-sqlite3`, WAL, numbered SQL migrations |
| Ledger | `@transia/xrpl` `Client` |
| HTTP | Fastify v5 + TypeBox |
| WS | `@fastify/websocket` |
| Config | `dotenv` |
| Logs | `pino` |
| Tests | `node:test` |
| Ship | Docker Compose, `node:20-bookworm-slim` (native module build) |

---

## 4. Identifier rules

**Internal token id:** `currency:issuer` (XRPL convention, never used in URLs).

**URL token:** `/v1/tokens/{currency}/{issuer}`

- `currency` is the 3-char code (`USD`) or the original 40-char hex if non-standard
- `issuer` is the r-address, validated with `isValidAddress`

**URL pair:** `/v1/prices/{base}/{counter}` and `/v1/trades/{base}/{counter}`

- Native asset segment is `XAH` (no issuer)
- IOU segment is the currency code only; issuer is `?base_issuer=` / `?counter_issuer=`
- Example: `/v1/prices/USD/XAH?base_issuer=rHb9…`
- Example: `/v1/prices/USD/EUR?base_issuer=rA…&counter_issuer=rB…`

**Why not `USD+r…` or `USD:r…`:** `:` is a URI delimiter; `+` becomes a space in query strings and is mishandled by some proxies. Two segments avoid both.

**Pair normalisation (storage):** order sides so `(currency + issuer)` is lexicographically smaller as `base`, larger as `counter`. Price is always **counter per base**. XAH issuer is `NULL`.

---

## 5. Process model

One Node process, two roles, one SQLite file:

```
boot
  ├─ open DB + migrate
  ├─ connect @transia/xrpl Client to XAHAUD_URL
  ├─ if snapshot incomplete → snapshot current validated ledger
  ├─ start TOML worker (async, never inside a ledger write)
  ├─ subscribe ledger + transactions
  └─ listen Fastify on API_HOST:API_PORT
```

- Ingester is single-threaded and owns writes.
- API only reads (plus WS fan-out after a committed ledger).
- Each closed ledger is one `db.transaction(...)()`.
- HTTP (TOML) must not run inside that transaction.

---

## 6. First-boot snapshot (the accuracy gate)

Live-only ingest cannot serve wallets or explorers. On an empty DB:

1. `ledger` / `ledger_closed` → validated index `L`.
2. Persist `indexer_state`: `snapshot_status=running`, `snapshot_ledger=L`.
3. Page `ledger_data` (`ledger_index: L`, JSON, follow `marker`). Persist the marker after every page so a crash resumes.
4. Classify each object:

   | `LedgerEntryType` | Action |
   |-------------------|--------|
   | `RippleState` | Upsert `trust_lines` + parent `tokens` / `issuers`; store remarks |
   | `URIToken` | Upsert `uri_tokens` + remarks; record mint ledger from `PreviousTxnLgrSeq` if that is all we have |
   | `AccountRoot` | Upsert `issuers` if Domain / flags / later referenced; store remarks |
   | `Hook` | Upsert `hook_accounts` + `issuers.has_hooks` from `Account` + `Hooks` |
   | `HookDefinition` | Upsert `hook_definitions` (defaults + `code_size`, never WASM) |
   | everything else | Ignore for v1 (except `SetRemarks` later) |

5. After the walk, recompute token aggregates (`holder_count`, `trust_count`, `supply`) from `trust_lines`.
6. Enqueue TOML verification for every issuer with a `Domain`.
7. Set `snapshot_status=complete`, `live_from_ledger=L+1`.
8. Subscribe. **Drop or ignore ledgers `<= L`.** State at `L` is already correct; replaying `L` would double-count.

If the process restarts mid-snapshot, reuse the same `snapshot_ledger` and marker. Do not start a second snapshot at a newer ledger.

`status` is `syncing` during snapshot, `live` when `network_ledger - indexed_ledger <= 2`, else `degraded`.

### What snapshot does not give us

- Historical DEX trades or candles (offers on the book are not executions)
- URIToken transfer history before `L` (we store current owner only; `mint_ledger` is best-effort)
- Burned URITokens (they are gone from the ledger)

Document this on `/v1/status` via `history_start_ledger` = `live_from_ledger`.

---

## 7. Live ingest

Subscribe: `ledger` + `transactions`. Process only `validated === true` and `meta.TransactionResult === tesSUCCESS`.

Reconnect: 1s → 2s → 4s … cap 60s. On reconnect, if the gap is `> 1` ledger, fetch missing ledgers with `ledger` (`transactions: true`) before continuing the stream. If the node cannot serve them, mark `degraded` and log; do not silently skip.

Per ledger (`src/ingester/ledger.ts`):

1. Insert `ledgers` row.
2. Fan out the tx set to domain handlers.
3. Commit.
4. Publish WS events for rows that changed.

### Tokens (`tokens.ts`)

Watch `TrustSet`, IOU `Payment`, issuer `AccountSet`.

- `holder_count`: distinct accounts with `balance != 0` (exclude the issuer).
- `trust_count`: all trust lines for the token, including zero balance.
- `supply`: absolute value of the issuer’s RippleState balances for that currency (standard IOU obligation). Store as a decimal string.

### URITokens (`uritokens.ts`)

Watch:

- `URITokenMint`
- `URITokenBurn`
- `URITokenCreateSellOffer`
- `URITokenCancelSellOffer`
- `URITokenBuy`
- `SetRemarks` where `object_type` resolves to `URIToken`

Store `Destination` on the sell offer (missing from the first draft). Transfers get a `uri_token_transfers` row on `URITokenBuy` (and on mint-to-destination if the metadata shows an immediate sale).

### Remarks (`remarks.ts`)

Shared decoder used by snapshot, URIToken, issuer, and trust-line paths.

```
RemarkName / RemarkValue are hex blobs.
Decode UTF-8; replace NULs.
If value is JSON, store the JSON string (still TEXT).
Omit RemarkValue → DELETE that name.
Flags & 1 → immutable = 1.
```

Treat XAS-007d as a **key convention**, not a parser dependency. Well-known keys (`name`, `description`, `image`, `icon`, `website`, `attributes`, …) are copied onto token / URIToken display fields when present; unknown keys stay in `remarks`.

v1 snapshot + live persist remarks for `URIToken`, `AccountRoot`, `RippleState`. Other `SetRemarks` targets: store the row keyed by `object_id` so we do not lose data, but do not join them onto API resources yet.

### Hooks (`hooks.ts`)

Watch `SetHook` metadata (`LedgerEntryType: Hook` and `HookDefinition`) and snapshot those objects. Do not read a hook array off `AccountRoot`. Store definition defaults and `code_size`, never `CreateCode`. Attach `label` at read time from `src/util/hookLabels.ts` (hash first, then Evernode system account).

Persist the full hook array as JSON **and** keep these fields per entry when present:

- `HookHash`, `HookNamespace`, `HookParameters`, `HookGrants`
- `HookOn` **or** `HookOnIncoming` / `HookOnOutgoing` (v2)
- `HookName`, `HookApiVersion`, `HookCanEmit`, flags

### Issuers + TOML (`issuers.ts`, `util/domain.ts`)

On first sight (snapshot or first trust line):

1. `account_info`
2. Domain hex → UTF-8
3. Queue `https://<domain>/.well-known/xahau.toml` (Xahau identity file only — never `xrp-ledger.toml`)
4. Verify the r-address appears under `[[ACCOUNTS]]` or `[[CURRENCIES]]`
5. Store `toml_*` fields + `toml_raw` as JSON
6. Re-verify about every 1000 ledgers, and on `AccountSet` that changes Domain

TOML failures: `domain_verified = 0`, expected network misses at debug, retry every 1000 ledgers. Never fail the ledger transaction.

**Blackholed:** `lsfDisableMaster` set **and** (`RegularKey` missing **or** RegularKey ∈ known blackhole set). Seed the set with the well-known XRPL/Xahau sink addresses (`rrrrrrrrrrrrrrrrrrrrBZbvji`, `rrrrrrrrrrrrrrrrrrrrn5RM1rHd`, and any Xahau-documented equivalents). Make the list a constant in `util/xahau.ts`.

### DEX (`dex.ts`)

From `OfferCreate`, `OfferDelete`, and auto-bridge `Payment` metadata, extract **executed** takes only (`meta.AffectedNodes` deleted/modified offers with a consumed amount).

Insert `dex_trades`. After each trade, upsert the calendar candles that contain it for periods `1h`, `24h`, `7d`.

**Candle alignment (UTC):**

| Period | `open_time` |
|--------|-------------|
| `1h` | `floor(ts / 3600) * 3600` |
| `24h` | `floor(ts / 86400) * 86400` (UTC day) |
| `7d` | `floor(ts / 604800) * 604800` (Unix-epoch weeks) |

Store `open_ledger` = first trade’s ledger in that bucket, `close_ledger` = last. Range queries filter on `open_time` or on ledger overlap.

Do **not** use rolling “last 24h” windows as stored rows. Rolling 24h change on `PriceSummary` is derived at read time from candles or trades.

---

## 8. Schema deltas vs the first draft

Keep the original tables. Add / change:

1. **`indexer_state`** — key/value for snapshot resume and `live_from_ledger`.
2. **`remarks`** — replaces `uri_token_remarks` as the only remarks table (object_id, object_type, name, value, immutable, plus denormalized `uri_token_id` / `account` / `token_id`).
3. **`uri_tokens.destination`** — optional r-address on an active sell offer.
4. **`ohlcv_candles.open_ledger` / `close_ledger`**
5. **`issuers.blackholed`** — denormalized for list filters (also stays on tokens).
6. Indexes for remarks by `account`, `token_id`, `uri_token_id`.

Full DDL is in `docs/architecture.md`. Migrations stay append-only: `001_init.sql` ships the final v1 schema (this is a greenfield repo).

---

## 9. API (v1)

Contract: `docs/openapi.yaml`. Envelope and errors unchanged.

| Method | Path | Notes |
|--------|------|-------|
| GET | `/v1/status` | Includes snapshot state + `history_start_ledger` |
| GET | `/v1/tokens` | Filters: issuer, currency, domain_verified, q, sort |
| GET | `/v1/tokens/{currency}/{issuer}` | Detail + issuer profile + price summary + remarks |
| GET | `/v1/tokens/{currency}/{issuer}/holders` | Paginated trust lines (explorer / wallet) |
| GET | `/v1/uritokens` | burned default false; `for_sale` |
| GET | `/v1/uritokens/{id}` | + remarks + transfers |
| GET | `/v1/issuers` | |
| GET | `/v1/issuers/{account}` | + tokens + hooks + remarks |
| GET | `/v1/prices/{base}/{counter}` | `period`, `from`, `to`, `from_ledger`, `to_ledger`, `limit` |
| GET | `/v1/trades/{base}/{counter}` | Same range params; raw tape for DEX UIs |
| GET | `/v1/hooks` | Optional `hook_hash` |
| GET | `/v1/hooks/{account}` | |
| GET | `/v1/hooks/definitions` | |
| GET | `/v1/hooks/definitions/{hook_hash}` | |
| WS | `/v1/subscribe` | streams: `tokens`, `uritokens`, `prices`, `hooks` |

CORS: `origin: true` (reflect request origin) or `*`. No auth plugin. Optional `@fastify/rate-limit` when `API_RATE_LIMIT_MAX` is set.

---

## 10. Build phases

Implement in this order. Each phase should leave `npm test` green and the process bootable.

### Phase 0 — Skeleton

`package.json` (ESM, Node 20), `tsconfig.json`, `.env.example`, `.gitignore`, `Dockerfile`, `docker-compose.yml`, `src/index.ts`, `src/config.ts`, Pino logger.

**Done when:** `npm run build` emits `dist/`, process starts and exits cleanly without a node (config validation).

### Phase 1 — DB + types

`src/types/{xahau,api,db}.ts`, `src/db/client.ts`, `src/db/migrations/001_init.sql`, query modules with no business logic.

**Done when:** boot creates `./data/xahauindex.db` and applies `001_init`.

### Phase 2 — Helpers

`util/xahau.ts` (currency decode, amounts, pair order, address / blackhole), `util/retry.ts`, `remarks.ts` decoder, `util/domain.ts` TOML parse (unit-tested with fixtures).

**Done when:** decoder + currency + pair tests cover 3-char, 40-hex, XAH, JSON remark values, deletes.

### Phase 3 — Snapshot

`ingester/snapshot.ts` pages `ledger_data`, writes objects, resumes marker, sets `live_from_ledger`.

**Done when:** a fixture `ledger_data` page (or a recorded mainnet page) produces the expected token / URIToken / hook / remark rows. Against live mainnet, `/v1/status` reports `syncing` then a non-zero `token_count`.

### Phase 4 — Live core + tokens

WS lifecycle, gap fill, ledger transaction, `tokens.ts` + issuer stub.

**Done when:** after snapshot, a TrustSet / Payment fixture updates balances and aggregates exactly once.

### Phase 5 — URITokens + SetRemarks

All URIToken tx types + remarks attach/update/delete.

**Done when:** mint → remark → sell → buy → burn fixture sequence matches OpenAPI objects.

### Phase 6 — Hooks + issuer TOML

`SetHook` array replace; TOML worker; blackhole flag; 1000-ledger re-verify.

**Done when:** TOML success/fail fixtures flip `domain_verified`; hook list filters by `hook_hash`.

### Phase 7 — DEX

Trade extraction + candle upsert + range queries.

**Done when:** three trades across an hour boundary create two `1h` candles; `from`/`to` and ledger filters return the expected subset.

### Phase 8 — API + WS

Fastify routes, TypeBox schemas, envelope, WS subscribe/unsubscribe.

**Done when:** route tests hit every OpenAPI path; WS test receives a `tokens` event after a fixture ledger.

### Phase 9 — Docker + polish

Compose volume, healthcheck on `/v1/status`, README quick start verified with `docker compose up`.

**Done when:** `docker compose up --build` serves `/v1/status` and persists the DB across a container recreate.

---

## 11. Testing strategy

- Prefer fixtures (captured JSON) over a live node in CI.
- One optional `test/live.mainnet.test.ts` gated by `LIVE_MAINNET=1`.
- Ingester functions take a `tx + meta + ledger` object; they do not talk to the network.
- Snapshot and TOML use injected request functions.
- No extra test framework. `node:test` + `node:assert/strict`.

---

## 12. Risks

| Risk | Mitigation |
|------|------------|
| `@transia/xrpl` types lag Remarks / HookOn v2 | Own types in `src/types/xahau.ts`; treat client as a WS/RPC transport |
| Public `wss://xahau.network` rate-limits `ledger_data` | Page slowly, persist marker, honour 429/backoff; document self-hosted xahaud as production |
| Snapshot is large | Stream pages; do not hold the full ledger in memory; WAL + periodic commits per page |
| Offer metadata shapes vary | Strict type guards; skip + `warn` with tx hash; add a fixture when a new shape appears |
| TOML / domain SSRF | Only `https` to the Domain host; no redirects to private IPs; timeout; size cap |
| `better-sqlite3` in Alpine | Do not use Alpine; bookworm-slim + build tools in a builder stage |

---

## 13. Environment

```env
XAHAUD_URL=wss://xahau.network
DB_PATH=./data/xahauindex.db
API_PORT=3000
API_HOST=0.0.0.0
LOG_LEVEL=info
# BACKFILL_FROM_LEDGER=genesis
# BACKFILL_LOOKBACK=10000
# BACKFILL_XAHAUD_URL=wss://your-full-history-node
# BACKFILL_ENV=.env.backfill
# FULL_HISTORY_START=
```

---

## 14. Implementation order after this PR

Next branch implements **Phase 0 → Phase 1** (skeleton + schema), then continues through the phases above on the same branch unless a phase needs its own PR.

Do not invent extra product surface. If a consumer need is not in the table in §2 or the OpenAPI file, it waits.
