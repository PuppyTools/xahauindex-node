# XahauIndex — Architecture

## Overview

XahauIndex has three layers: an **ingester** (snapshot + live WebSocket), a **SQLite database**, and a **Fastify API**. XahauIndex is an independent PuppyTools project — not affiliated with, endorsed by, or a product of the Xahau network or its operators. The XI mark is original artwork inspired by [Xahau/Graphics](https://github.com/Xahau/Graphics).

```
┌─────────────────────────────────────────────────────────────────┐
│  xahaud node  (wss://xahau.network or self-hosted)              │
└─────────────┬─────────────────────────────────┬───────────────┘
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
└──────────────────────────┬───────────────────────────────────────┘
                           │  better-sqlite3
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  SQLite  (DB_PATH, default ./data/xahauindex.db)                 │
└──────────────────────────┬───────────────────────────────────────┘
                           │  reads
                           ▼
┌─────────────────────────────────────────────────────────────────┐
│  Fastify API  :API_PORT/docs (from openapi.yaml) + /v1/…         │
└─────────────────────────────────────────────────────────────────┘
```
