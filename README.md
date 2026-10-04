# XahauIndex

**Self-hostable metadata indexer for the [Xahau](https://xahau.network) network.**

XahauIndex connects to a xahaud node, snapshots the current ledger, follows it in real time, and serves an enriched REST + WebSocket API covering IOU tokens, URITokens, issuer profiles, DEX prices, and Hook activity — the Xahau equivalent of [xrplmeta](https://github.com/xrplmeta/node).

> Run your own instance. No API key. Put a reverse proxy in front if you want TLS.

---

## Features

- **Current-ledger snapshot** — holder counts, supply, URITokens, and Hooks are correct on first boot
- **IOU tokens** — trust lines, holders, issuer metadata, supply, remarks
- **URITokens** — Xahau native NFTs; mint / sell / transfer / burn plus Remarks
- **Issuer profiles** — domain verification via `/.well-known/xahau.toml`, blackhole detection, AccountRoot remarks
- **Icon URLs** — remarks, TOML, and URI metadata JSON store `https` / `ipfs` links only. No image cache or CDN.
- **URIToken metadata** — if the on-ledger URI is HTTPS JSON, that document is stored on the token (`metadata`) besides the icon link.
- **DEX prices** — OHLCV (`1h` / `24h` / `7d`) and a trade tape, filterable by time or ledger range
- **Optional history backfill** — walk closed ledgers back from the snapshot (genesis or a lookback) for trades and URIToken transfers without rewriting current balances
- **Hook activity** — which accounts have Hooks installed and which hashes
- **Real-time WebSocket** — token, URIToken, price, and hook streams
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
LOG_LEVEL=info
# BACKFILL_FROM_LEDGER=genesis
# BACKFILL_LOOKBACK=10000
# BACKFILL_XAHAUD_URL=wss://your-full-history-node
# BACKFILL_ENV=.env.backfill
```

Default network is **Xahau mainnet**. A public WebSocket is fine for development; a local xahaud is better for snapshot speed.

Historical backfill is **off** unless you set one of:

| Variable | Meaning |
|----------|---------|
| `BACKFILL_FROM_LEDGER` | Earliest ledger to walk down to. `genesis` / `start` = `1`. Alias: `FULL_HISTORY_START`. |
| `BACKFILL_LOOKBACK` | Walk `LOOKBACK` ledgers back from the snapshot when `FROM` is unset. |
| `BACKFILL_XAHAUD_URL` | Dedicated full-history node for backfill only (`ws`/`wss` or `http`/`https` JSON-RPC). Live subscribe still uses `XAHAUD_URL`. |
| `BACKFILL_ENV` | Optional second env file. `XAHAUD_URL` or `BACKFILL_XAHAUD_URL` in that file is the history node. Defaults to `.env.backfill` when that file exists. |
| `BACKFILL_MIN_INTERVAL_MS` | Delay between historical fetches. Unset = `400` when sharing `XAHAUD_URL`, `0` on a dedicated history node. |

If both stop bounds are set, `BACKFILL_FROM_LEDGER` wins. The walk starts at the snapshot ledger and decrements until that bound — `genesis` means keep going backward until ledger 1. Resume is the next lower ledger (`backfill_next`). Use a full-history node for backfill when the subscription node does not keep old ledgers. Sharing the public RPC with live subscribe is paced so a genesis walk cannot exhaust the 10s quota and drop the live stream. `tooBusy` / rate-limit responses wait for the hinted retry, then continue — they do not skip a ledger or stop the process. Public nodes that still cannot serve an index are retried, then skipped. The snapshot remains the source of current balances, owners, issuers, and Hooks. Backfill records DEX trades and URIToken transfers only.

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
| GET | `/v1/hooks/{account}` | Hook state |

```
WS /v1/subscribe
{ "command": "subscribe", "streams": ["tokens", "uritokens", "prices", "hooks"] }
```

Full contract: [`docs/openapi.yaml`](docs/openapi.yaml).

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

**Hooks** are smart contracts attached to accounts. XahauIndex stores the active Hook array.

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
- **v1.1** — auth/rate limiting
- **v2.0** — public hosted instance, client SDK
- **v3.0** — Governance Game, bridge tracking

---

## License

MIT
