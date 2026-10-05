# XahauIndex — Cursor Context

> Read this file at the start of every session. It is the authoritative guide to this codebase.

## Project summary

XahauIndex is a **self-hostable Node.js + TypeScript metadata indexer for the Xahau network** (smart-contract sidechain of the XRP Ledger). It snapshots the current validated ledger, then follows live streams, and exposes an enriched REST + WebSocket API for IOU tokens, URITokens, issuer profiles, DEX prices, and Hook activity. Independent PuppyTools project — not affiliated with Xahau. XI mark inspired by [Xahau/Graphics](https://github.com/Xahau/Graphics).

Repo: `github.com/PuppyTools/xahauindex-node`

## Technology decisions — do not change without discussion

| Concern | Choice | Reason |
|---------|--------|--------|
| Language | TypeScript (strict) | Type safety for complex ledger object shapes |
| Runtime | Node.js 22+ ESM | better-sqlite3 13 requires Node 22+ |
| Build | `tsc` → `dist/` | Standard, no bundler complexity needed |
| Database | SQLite (`better-sqlite3`) | Zero-dependency self-hosting |
| Ledger client | `@transia/xrpl` | Xahau-specific types (URIToken, SetHook, SetRemarks) |
| HTTP server | Fastify v5 + TypeBox | Performance, compile-time safe schemas |
| WS server | `@fastify/websocket` | Integrates with Fastify lifecycle |
| Migrations | numbered SQL files, append-only | Simple |
| Config | `dotenv` | Standard |
| Logging | `pino` | Structured JSON, low overhead |
| Tests | `node:test` | No extra deps |

`@transia/xrpl` is a transport + helper library. **All Xahau ledger object shapes we persist are typed in `src/types/xahau.ts`.** Do not assume the package is complete for HookOn v2 or Remarks.

## TypeScript rules

- `strict: true`, `noUncheckedIndexedAccess: true` — no exceptions
- **Never use `any`** — use `unknown` and narrow with type guards, or define an interface
- All Xahau ledger object shapes typed in `src/types/xahau.ts`
- API response/request shapes typed in `src/types/api.ts`
- DB row shapes typed in `src/types/db.ts`
- `@typescript-eslint` recommended rules enforced

## Directory structure

```
src/
  index.ts          — entry point
  config.ts         — env var loading + typed Config export
  types/
    xahau.ts        — URIToken, AccountRoot, HookEntry, Remark, LedgerTx interfaces
    api.ts          — API response/request types
    db.ts           — DB row types (one per table)
  db/
    client.ts       — SQLite singleton + migration runner
    migrations/     — 001_init.sql, 002_*.sql … (append only, never edit existing)
    queries/        — tokens.ts, uritokens.ts, issuers.ts, dex.ts, hooks.ts, remarks.ts
  ingester/
    index.ts        — WebSocket lifecycle manager
    snapshot.ts     — ledger_data walk + resume; retarget if L is gone
    backfill.ts     — optional historical tx walk, snapshot → FROM (trades + URIToken transfers)
    historyDb.ts    — bulk import from xahaud ledger.db + transaction.db
    historyDecode.ts — RawTxn / TxnMeta binary → ClosedLedger txs
    ledger.ts       — ledger_closed handler, orchestrates batch processing
    tokens.ts       — IOU trust-line ingestion
    uritokens.ts    — URIToken lifecycle
    hooks.ts        — Hook state tracking
    remarks.ts      — Remarks decoder + SetRemarks apply
    metadata.ts     — URI metadata JSON → icon URL (no image bytes)
    issuers.ts      — issuer profile + Xahau xahau.toml (ACCOUNTS / CURRENCIES)
    dex.ts          — DEX executions → OHLCV candles
  api/
    index.ts        — Fastify plugin registration
    routes/         — one file per resource group (docs.ts serves generated /docs)
    docsPage.ts     — branded HTML + cookbook markdown from OpenAPI
    openapi.ts      — load / parse docs/openapi.yaml
    schemas/        — TypeBox schemas for request params + response shapes
  util/
    xahau.ts        — currency normalisation, account validation, hex helpers, blackhole
    domain.ts       — /.well-known/xahau.toml fetcher/parser
    hookOn.ts       — HookOn / HookCanEmit bitmask → transaction type names
    hookLabels.ts   — static Evernode (and later) hook-hash / account labels
    uriPayload.ts   — classify URI + decode on-chain URI blobs (Evernode evrlease)
    retry.ts        — exponential backoff
public/docs/        — docs.css for the generated /docs page
dist/               — compiled output (gitignored)
docs/
  implementation-plan.md
  architecture.md
  openapi.yaml      — source of truth for /docs, cookbook, and README curls
  cookbook.md       — generated (`npm run docs:sync`)
test/               — mirrors src/ structure
```

## Xahau concepts Cursor must understand

### URITokens
Xahau's native NFT format. **Not** XLS-20 NFTs. Key fields:
- `URITokenID` / ledger `index` — unique 64-char hex ID
- `URI` — hex-encoded URI (decode to UTF-8)
- `Issuer`, `Owner`
- `Digest` — optional content hash
- `Amount` — present only when a sell offer is set
- `Destination` — optional buyer restriction on the sell offer

### Hooks
Xahau stores installed hooks on a dedicated `LedgerEntryType: Hook` object (`Account` + `Hooks` array), not on `AccountRoot`. The WASM and defaults live on an unowned `HookDefinition` keyed by `HookHash`. Persist the install slot (`HookHash`, parameters, grants, namespace, HookOn v1/v2, `HookCanEmit`) and the definition (`code_size`, default HookOn, namespace, parameters, fees, reference count). Do **not** store `CreateCode`. Decode HookOn bitmasks at read time ([active-low except bit 22](https://xahau.network/docs/hooks/concepts/hookon-field/)). Empty `{ Hook: {} }` slots are ignored. `label` is a static catalog (`src/util/hookLabels.ts`): match current Evernode hashes, or the stable Evernode system account if the hash has rotated.

### Remarks
On-ledger key/value metadata via the Remarks amendment / `SetRemarks`. Each entry is hex `RemarkName` + optional `RemarkValue` (omit value to delete). Max 32 per object. `Flags & 1` = immutable.

v1 indexes remarks on URITokens, issuer AccountRoots, and issuer-side RippleState (trust lines). XAS-007d is a key-naming convention, not a separate binary format.

### Currency codes
- 3-char uppercase: standard (`USD`, `XAH`)
- 40-char hex: decode UTF-8, strip NULs; keep original hex
- Amounts: always **strings**

### Account addresses
Always base58 r-address. Validate with `@transia/xrpl` `isValidAddress()`.

### Blackholed
`lsfDisableMaster` **and** (no `RegularKey` **or** RegularKey is a known blackhole address).

### Identifiers
- DB token id: `currency:issuer`
- URL token: `/v1/tokens/{currency}/{issuer}` — never `:` or `+` in one segment
- URL pair: `/v1/prices/{base}/{counter}` with `base_issuer` / `counter_issuer` query params
- URL trades for one asset: `/v1/trades/{currency}` with `issuer` (or `base_issuer`) when that side is an IOU
- Native asset code: `XAH`, issuer `NULL`

## Coding style

- **TypeScript strict mode** — no `any`, no `// @ts-ignore`
- **ESM only** — `import`/`export`, no `require()`
- **Async/await** — no raw `.then()` chains
- **DB writes in transactions** — `db.transaction(fn)()`
- **Snapshot and TOML stay out of the ledger write**
- **Validate before writing** — log and skip malformed objects
- **No silent failures** — unexpected ingester events at `warn`/`error` with tx hash + ledger
- **API envelope** — `{ data, meta: { count?, page?, per_page?, ledger_index? } }`
- **API errors** — `{ error: { code, message } }` with the correct HTTP status

## Environment variables

Copy `.env.example` to `.env`. Never commit `.env`.

- `XAHAUD_URL` — default `wss://xahau.network`
- `DB_PATH` — default `./data/xahauindex.db`
- `API_PORT` / `API_HOST` — default `3000` / `0.0.0.0`
- `API_BASE_URL` — public origin for `/docs` cookbook curls, Open links, and `/v1/openapi.yaml`. Default `http://localhost:3000` when unset. Does not change the listen address. Project site: `https://xahauindex.dev`.
- `LOG_LEVEL` — `trace|debug|info|warn|error`
- `BACKFILL_FROM_LEDGER` — optional earliest ledger the walk stops at (`genesis`/`start` = `1`). Alias: `FULL_HISTORY_START`.
- `BACKFILL_LOOKBACK` — if `FROM` is unset, stop at `snapshot - lookback + 1`. Neither set = no backfill. Walk is snapshot → FROM.
- `BACKFILL_XAHAUD_URL` — optional dedicated history node (`ws`/`wss` or `http`/`https` JSON-RPC). Unset = reuse `XAHAUD_URL`. Live subscribe stays on `XAHAUD_URL` at the current tip; this node fills last-indexed → tip first, then walks backward.
- `BACKFILL_ENV` — optional second env file for that node URL. Auto-loads `.env.backfill` when present.
- `BACKFILL_MIN_INTERVAL_MS` — delay between historical fetches. Unset = `2000` when sharing the live node (public RPC quotas), `0` on a dedicated history URL. A shared node also gives live fetches priority and pauses backfill after `tooBusy`.
- `BACKFILL_FROM_DB` — optional. After snapshot + live gap fill, import a copy of xahaud `ledger.db` + `transaction.db`. RPC then fills only the remainder.
- `HISTORY_LEDGER_DB` / `HISTORY_TX_DB` — required when `BACKFILL_FROM_DB` is set. Read-only copy; never a live node's files.
- `HISTORY_BATCH_SIZE` — default `500`.
- `HISTORY_WORKERS` — decode stripes / event-loop yield. Default `4`. Concurrent RPC workers are a separate follow-up.
- `API_RATE_LIMIT_MAX` — optional HTTP requests per IP per window. Unset / `0` = off. No API keys.
- `API_RATE_LIMIT_WINDOW_MS` — default `60000`.
- `API_TRUST_PROXY` — default `false`. Set `true` only behind a reverse proxy that sets `X-Forwarded-For`.
- `API_RATE_LIMIT_ALLOW` — comma-separated IPs / CIDRs that skip the limiter.
- `API_WS_MAX_PER_IP` — concurrent `/v1/subscribe` sockets per IP. Unset = `8` when `MAX` is set, unlimited when off. `0` disables the cap.

## Running locally

```bash
cp .env.example .env
npm install
npm run dev       # tsx watch src/index.ts
npm run build
npm test
```

`allowScripts` in `package.json` permits `better-sqlite3` and `esbuild` install scripts (npm 11.16+ / 12).

## Docker

```bash
docker compose up -d
```

Data persists in `xahauindex_data`. SQLite at `/data/xahauindex.db` inside the container.

## v1 scope

In: current-ledger snapshot · live ingest · optional historical backfill (env-bounded) · IOU tokens · URITokens · remarks (URIToken / issuer / trust line) · issuer TOML · DEX historical OHLCV + trades · Hooks · REST + WS · Docker · no API key · optional operator IP rate limit

Out: auth / API keys · Governance Game · multi-node federation · icon CDN / image byte cache

Icon URLs come from remarks, issuer TOML, or URI metadata JSON. Persist the URL string only — never download, store, or proxy image bytes. `data:` URIs are rejected. When a URIToken URI is HTTPS JSON metadata, store that JSON on the token as well.

History mode must not overwrite snapshot balances, owners, issuers, or Hooks. It records DEX trades and URIToken transfers only. The walk starts at the snapshot ledger and decrements to `FROM` / genesis so recent candles exist first.

---

When in doubt: `docs/implementation-plan.md` for sequencing, `docs/architecture.md` for the data model, `docs/openapi.yaml` for API contracts.
