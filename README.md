# XahauIndex

**Self-hostable metadata indexer for the [Xahau](https://xahau.network) network.**

XahauIndex connects to a xahaud node, snapshots the current ledger, follows it in real time, and serves an enriched REST + WebSocket API covering IOU tokens, URITokens, issuer profiles, DEX prices, and Hook activity — the Xahau equivalent of [xrplmeta](https://github.com/xrplmeta/node).

> Project site: [https://xahauindex.dev](https://xahauindex.dev). Or run your own — no API key. Put a reverse proxy in front if you want TLS. Optional IP rate limits are env-off.

XahauIndex is an independent [PuppyTools](https://github.com/PuppyTools) project. It is not affiliated with, endorsed by, or a product of the [Xahau](https://xahau.network) network or its operators. The XI mark is original artwork inspired by the official letterforms in [Xahau/Graphics](https://github.com/Xahau/Graphics).

---

## Features

- **Current-ledger snapshot** — holder counts, supply, URITokens, and Hooks are correct on first boot
- **IOU tokens** — trust lines, holders, issuer metadata, supply, remarks
- **URITokens** — Xahau native NFTs; mint / sell / transfer / burn plus Remarks
- **Issuer profiles** — domain verification via `/.well-known/xahau.toml`, blackhole detection, AccountRoot remarks
- **Icon URLs** — remarks, TOML, and URI metadata JSON store `https` / `ipfs` links only. No image cache or CDN.
- **URIToken metadata** — HTTPS JSON URIs are fetched and stored. Packed on-chain URIs (Evernode `evrlease`, text, bytes) are decoded into `metadata` at read time so the token is still viewable.
- **DEX prices** — OHLCV (`1h` / `24h` / `7d`) and a trade tape, filterable by time or ledger range
- **Optional history backfill** — walk closed ledgers back from the snapshot (genesis or a lookback) for trades and URIToken transfers without rewriting current balances
- **Hook activity** — which accounts have Hooks installed, HookDefinition metadata, decoded HookOn triggers, and catalog labels for known hashes (Evernode governor / registry / heartbeat / reputation)
- **Real-time WebSocket** — indexed `tokens`, `uritokens`, `prices`, and `hooks` streams (same objects as REST, not a xahaud ledger subscribe)
- **Docker-first** — `docker compose up`

---

## Quick start

### Docker (recommended)

```bash
git clone https://github.com/PuppyTools/xahauindex-node
cd xahauindex-node
cp .env.example .env
# edit .env — set XAHAUD_URL if you run your own xahaud
docker compose up -d
```

The API listens on `http://localhost:3000`. Docs are at `http://localhost:3000/docs`. Point a reverse proxy at that port for public access.

### Node.js (development)

```bash
node --version  # requires Node.js 20+
npm install
cp .env.example .env
npm run dev
```

`package.json` already allowlists the install scripts for `better-sqlite3` (native SQLite binding) and `esbuild` (via `tsx`). npm 11.16+ / 12 skip those unless they are listed.

---

## Configuration

Copy `.env.example` to `.env`:

```env
XAHAUD_URL=wss://xahau.network
DB_PATH=./data/xahauindex.db
API_PORT=3000
API_HOST=0.0.0.0
# API_BASE_URL=https://xahauindex.dev
LOG_LEVEL=info
# BACKFILL_FROM_LEDGER=genesis
# BACKFILL_LOOKBACK=10000
# BACKFILL_XAHAUD_URL=wss://your-full-history-node
# BACKFILL_ENV=.env.backfill
# API_RATE_LIMIT_MAX=120
```

Default network is **Xahau mainnet**. A public WebSocket is fine for development; a local xahaud is better for snapshot speed.

Historical backfill is **off** unless you set one of:

| Variable | Meaning |
|----------|---------|
| `BACKFILL_FROM_LEDGER` | Earliest ledger to walk down to. `genesis` / `start` = `1`. Alias: `FULL_HISTORY_START`. |
| `BACKFILL_LOOKBACK` | Walk `LOOKBACK` ledgers back from the snapshot when `FROM` is unset. |
| `BACKFILL_XAHAUD_URL` | Dedicated full-history node for backfill only (`ws`/`wss` or `http`/`https` JSON-RPC). Live subscribe still uses `XAHAUD_URL`. |
| `BACKFILL_ENV` | Optional second env file. `XAHAUD_URL` or `BACKFILL_XAHAUD_URL` in that file is the history node. Defaults to `.env.backfill` when that file exists. |
| `BACKFILL_MIN_INTERVAL_MS` | Delay between historical fetches. Unset = `2000` when sharing `XAHAUD_URL`, `0` on a dedicated history node. |

If both stop bounds are set, `BACKFILL_FROM_LEDGER` wins. The walk starts at the snapshot ledger and decrements until that bound — `genesis` means keep going backward until ledger 1. Resume is the next lower ledger (`backfill_next`). Use a full-history node for backfill when the subscription node does not keep old ledgers. Sharing the public RPC with live subscribe is paced (2s) so a genesis walk cannot exhaust the 10s quota and drop the live stream. Live fetches win the shared socket; `tooBusy` sets one cooldown and pauses backfill so both sides do not retry together. Rate-limit responses do not skip a ledger or stop the process. Public nodes that still cannot serve an index are retried, then skipped. The snapshot remains the source of current balances, owners, issuers, and Hooks. Backfill records DEX trades and URIToken transfers only.

`API_BASE_URL` is the origin written into `/docs` cookbook curls, endpoint Open links, and `/v1/openapi.yaml`. Default `http://localhost:3000` when unset. It does not change `API_HOST` / `API_PORT`. The hosted project site is [https://xahauindex.dev](https://xahauindex.dev).

Operator rate limiting is **off** unless `API_RATE_LIMIT_MAX` is a positive integer. There is still no API key.

| Variable | Meaning |
|----------|---------|
| `API_RATE_LIMIT_MAX` | HTTP requests per client IP per window. Unset / `0` = unlimited. |
| `API_RATE_LIMIT_WINDOW_MS` | Window length. Default `60000`. |
| `API_TRUST_PROXY` | `true` when a reverse proxy sets `X-Forwarded-For`. Leave `false` on a bare `:3000` so clients cannot spoof the key. |
| `API_RATE_LIMIT_ALLOW` | Comma-separated IPs / CIDRs that skip the limiter. |
| `API_WS_MAX_PER_IP` | Concurrent `/v1/subscribe` sockets per IP. Unset = `8` when `MAX` is set, unlimited when `MAX` is off. `0` disables the cap. |

Over the limit the API returns `429` `{ error: { code: "RATE_LIMITED", message: "Too many requests" } }` with `Retry-After`. `/`, `/docs`, `/docs/*`, and `/v1/openapi.yaml` are not counted, so opening the docs page does not burn the quota. A public instance can start at `API_RATE_LIMIT_MAX=120`. Docker health checks hit `127.0.0.1`; add that address to `API_RATE_LIMIT_ALLOW` if the max is very low.

---

## API

Base URL: `http://localhost:3000`

Human docs: [`/docs`](http://localhost:3000/docs). Machine contract: [`/v1/openapi.yaml`](http://localhost:3000/v1/openapi.yaml).

All responses use `{ data, meta: { count, page, ledger_index } }`.

Token and pair identifiers use **separate path segments** (no `:` or `+` in one segment):

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1/status` | Sync / snapshot health |
| GET | `/v1/tokens` | List IOU tokens |
| GET | `/v1/tokens/{currency}/{issuer}` | Token detail |
| GET | `/v1/tokens/{currency}/{issuer}/holders` | Trust lines / holders |
| GET | `/v1/uritokens` | List URITokens |
| GET | `/v1/uritokens/{id}` | URIToken detail + transfers |
| GET | `/v1/issuers` | List issuers |
| GET | `/v1/issuers/{account}` | Issuer profile |
| GET | `/v1/prices/{base}/{counter}` | OHLCV candles (`from` / `to` / ledger range) |
| GET | `/v1/trades/{base}/{counter}` | Executed DEX trades |
| GET | `/v1/hooks` | Accounts with Hooks |
| GET | `/v1/hooks/{account}` | Hook state (`label` + `triggers` + `definition`) |
| GET | `/v1/hooks/definitions` | HookDefinition catalog |
| GET | `/v1/hooks/definitions/{hook_hash}` | One HookDefinition |

```
WS /v1/subscribe
{ "command": "subscribe", "streams": ["tokens", "uritokens", "prices", "hooks"] }
```

Human docs at `/docs` are generated from [`docs/openapi.yaml`](docs/openapi.yaml). The same cookbook is at [`docs/cookbook.md`](docs/cookbook.md). After changing examples or curls, run `npm run docs:sync`.

<!-- COOKBOOK:START -->

## Wait for the snapshot

Token, URIToken, issuer, and Hook lists stay empty until `snapshot_status` is `complete`.

```bash
curl -s http://localhost:3000/v1/status
```

## List verified tokens

```bash
curl -s 'http://localhost:3000/v1/tokens?domain_verified=true&per_page=5'
```

## Token detail

```bash
curl -s http://localhost:3000/v1/tokens/USD/rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh
```

## Token holders

```bash
curl -s 'http://localhost:3000/v1/tokens/USD/rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh/holders?nonzero=true'
```

## URITokens for an owner

```bash
curl -s 'http://localhost:3000/v1/uritokens?owner=rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh&per_page=5'
```

## URIToken detail

`id` is the 64-character hex URITokenID. Packed on-chain URIs return `metadata.source: "onchain"`.

```bash
curl -s http://localhost:3000/v1/uritokens/CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC
```

## Issuer profile

```bash
curl -s http://localhost:3000/v1/issuers/rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh
```

## OHLCV candles

```bash
curl -s 'http://localhost:3000/v1/prices/USD/XAH?base_issuer=rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh&period=1h&limit=24'
```

## DEX trade tape

```bash
curl -s 'http://localhost:3000/v1/trades/USD/XAH?base_issuer=rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh&per_page=5'
```

## Account hook state

```bash
curl -s http://localhost:3000/v1/hooks/rHktfGUbjqzU4GsYCMc1pDjdHXb5CJamto
```

## Hook definitions

```bash
curl -s 'http://localhost:3000/v1/hooks/definitions?per_page=5'
```

## WebSocket subscribe

Not a xahaud `ledger` / `transactions` subscribe. Those sockets emit raw protocol traffic. This one pushes the same enriched objects as REST (`tokens`, `uritokens`, `prices`, `hooks`) after this node has indexed them.


```bash
npx wscat -c ws://localhost:3000/v1/subscribe
# then send:
# {"command":"subscribe","streams":["tokens","uritokens","prices","hooks"]}
```

<!-- COOKBOOK:END -->

---

## Architecture

```
xahaud
  │  ledger_data (first boot) + WebSocket (live)
  ▼
Ingester  →  SQLite  →  Fastify REST + WebSocket
```

See [`docs/architecture.md`](docs/architecture.md) and [`docs/implementation-plan.md`](docs/implementation-plan.md).

---

## Xahau concepts

**URITokens** are Xahau's native NFT format (not XLS-20). Each has a `URITokenID`, a hex `URI`, and optional Remarks.

**Hooks** are smart contracts attached to accounts. On Xahau they live on a `Hook` ledger object (`Account` + `Hooks` array), not on `AccountRoot`. The WASM and defaults live on a shared `HookDefinition`. XahauIndex stores the install array plus definition metadata (`code_size`, default HookOn, namespace, parameters, fees) and decodes HookOn into `triggers`. Bytecode is not stored. Known hashes (and the four Evernode system accounts) get a `label` at read time — hashes rotate when governance elects new WASM, so the account fallback still names those slots.

A finished snapshot is required for `/v1/hooks`. Restarting a node that already marked the snapshot complete does not re-walk Hook objects. After upgrading to Hook-object ingest, wipe the SQLite file (or clear `snapshot_status`) and resnapshot.

**Remarks** are on-ledger `{ name, value }` pairs (hex). v1 indexes them on URITokens, issuer accounts, and issuer-side trust lines.

---

## Comparable tools

| Tool | Hosted | Open source | Xahau | URITokens | Hooks |
|------|--------|-------------|-------|-----------|-------|
| **XahauIndex** | self-host | ✅ | ✅ | ✅ | ✅ |
| xrplmeta node | self-host | ✅ | ❌ | ❌ | ❌ |
| Bithomp API | hosted | ❌ | ✅ | partial | ❌ |
| data.xahau.network | hosted | ❌ | ✅ | raw | ❌ |

---

## Roadmap

- **v1.0** — snapshot + live, IOUs, URITokens, remarks, issuers, DEX candles/trades, Hooks, REST + WS, Docker, optional historical backfill
- **v1.1** — optional operator rate limiting (no API keys)
- **v2.0** — public hosted instance, client SDK
- **v3.0** — Governance Game, bridge tracking

---

## License

MIT.

XahauIndex is not affiliated with Xahau. See the notice at the top of this README. The XI mark credits [Xahau/Graphics](https://github.com/Xahau/Graphics) for the letterform inspiration.
