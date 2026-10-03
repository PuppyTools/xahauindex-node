# XahauIndex — Cursor Context

> Read this file at the start of every session. It is the authoritative guide to this codebase.

## Project summary

XahauIndex is a **self-hostable Node.js + TypeScript metadata indexer for the Xahau network** (smart-contract sidechain of the XRP Ledger). It snapshots the current validated ledger, then follows live streams, and exposes an enriched REST + WebSocket API for IOU tokens, URITokens, issuer profiles, DEX prices, and Hook activity.

Repo: `github.com/PuppyTools/xahauindex-node`

## Technology decisions — do not change without discussion

| Concern | Choice | Reason |
|---------|--------|--------|
| Language | TypeScript (strict) | Type safety for complex ledger object shapes |
| Runtime | Node.js 20+ ESM | Owner preference |
| Build | `tsc` → `dist/` | Standard, no bundler complexity needed |
| Database | SQLite (`better-sqlite3`) | Zero-dependency self-hosting |
| Ledger client | `@transia/xrpl` | Xahau-specific types (URIToken, SetHook, SetRemarks) |
| HTTP server | Fastify v4 + TypeBox | Performance, compile-time safe schemas |
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
    snapshot.ts     — ledger_data walk + resume
    ledger.ts       — ledger_closed handler, orchestrates batch processing
    tokens.ts       — IOU trust-line ingestion
    uritokens.ts    — URIToken lifecycle
    hooks.ts        — Hook state tracking
    remarks.ts      — Remarks decoder + SetRemarks apply
    issuers.ts      — issuer profile + domain TOML verification
    dex.ts          — DEX executions → OHLCV candles
  api/
    index.ts        — Fastify plugin registration
    routes/         — one file per resource group
    schemas/        — TypeBox schemas for request params + response shapes
  util/
    xahau.ts        — currency normalisation, account validation, hex helpers, blackhole
    domain.ts       — /.well-known/xrp-ledger.toml fetcher/parser
    retry.ts        — exponential backoff
dist/               — compiled output (gitignored)
docs/
  implementation-plan.md
  architecture.md
  openapi.yaml
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
Smart contracts on the account (`Hook` array on `AccountRoot`). Persist `HookHash`, parameters, grants, namespace, `HookOn` **and** `HookOnIncoming` / `HookOnOutgoing` / `HookName` when present.

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
- `LOG_LEVEL` — `trace|debug|info|warn|error`

## Running locally

```bash
cp .env.example .env
npm install
npm run dev       # tsx watch src/index.ts
npm run build
npm test
```

## Docker

```bash
docker compose up -d
```

Data persists in `xahauindex_data`. SQLite at `/data/xahauindex.db` inside the container.

## v1 scope

In: current-ledger snapshot · live ingest · IOU tokens · URITokens · remarks (URIToken / issuer / trust line) · issuer TOML · DEX historical OHLCV + trades · Hooks · REST + WS · Docker · no API key

Out: genesis tx backfill · auth/rate limiting · Governance Game · multi-node federation · off-ledger metadata scrape

---

When in doubt: `docs/implementation-plan.md` for sequencing, `docs/architecture.md` for the data model, `docs/openapi.yaml` for API contracts.
