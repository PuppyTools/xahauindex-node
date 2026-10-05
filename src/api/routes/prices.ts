import type { FastifyPluginAsync } from 'fastify';

import type { SqliteDatabase } from '../../db/client.js';
import { getLatestLedgerIndex } from '../../db/queries/indexer.js';
import {
  countDexTrades,
  countDexTradesForCurrency,
  listDexTrades,
  listDexTradesForCurrency,
  listOhlcvCandles,
} from '../../db/queries/dex.js';
import { readHistoryStartLedger } from '../../db/queries/status.js';
import type { DexTradeRow, OhlcvPeriod } from '../../types/db.js';
import { candleFromRow, tradeFromRow } from '../mappers.js';
import { parseRequestedCurrency, parseRequestedPair } from '../pair.js';
import { asQuery, parseLimit, parseOptionalInt, parsePage, parsePerPage } from '../query.js';

function rangeOpts(query: Record<string, string | undefined>): {
  from?: number;
  to?: number;
  fromLedger?: number;
  toLedger?: number;
} {
  const from = parseOptionalInt(query.from);
  const to = parseOptionalInt(query.to);
  const fromLedger = parseOptionalInt(query.from_ledger);
  const toLedger = parseOptionalInt(query.to_ledger);
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(fromLedger === undefined ? {} : { fromLedger }),
    ...(toLedger === undefined ? {} : { toLedger }),
  };
}

export const priceRoutes: FastifyPluginAsync = async (app) => {
  app.get('/v1/prices/:base/:counter', async (request) => {
    const params = request.params as { base: string; counter: string };
    const query = asQuery(request.query);
    const pair = parseRequestedPair(params.base, params.counter, query.base_issuer, query.counter_issuer);
    const period: OhlcvPeriod =
      query.period === '1h' || query.period === '24h' || query.period === '7d' ? query.period : '24h';
    const limit = parseLimit(query.limit);
    const rows = listOhlcvCandles(app.db, pair.stored, {
      period,
      limit,
      ...rangeOpts(query),
    });
    const start = readHistoryStartLedger(app.db);
    return {
      data: rows.map((row) => candleFromRow(row)),
      meta: {
        count: rows.length,
        ledger_index: getLatestLedgerIndex(app.db),
        ...(start === null ? {} : { history_start_ledger: start }),
      },
    };
  });

  app.get('/v1/trades/:currency', async (request) => {
    const params = request.params as { currency: string };
    const query = asQuery(request.query);
    const side = parseRequestedCurrency(params.currency, query.issuer ?? query.base_issuer);
    return tradesEnvelope(app.db, query, {
      list: (range, limit, offset) =>
        listDexTradesForCurrency(app.db, side, { ...range, limit, offset }),
      count: (range) => countDexTradesForCurrency(app.db, side, range),
    });
  });

  app.get('/v1/trades/:base/:counter', async (request) => {
    const params = request.params as { base: string; counter: string };
    const query = asQuery(request.query);
    const pair = parseRequestedPair(params.base, params.counter, query.base_issuer, query.counter_issuer);
    return tradesEnvelope(app.db, query, {
      list: (range, limit, offset) => listDexTrades(app.db, pair.stored, { ...range, limit, offset }),
      count: (range) => countDexTrades(app.db, pair.stored, range),
    });
  });
};

function tradesEnvelope(
  db: SqliteDatabase,
  query: Record<string, string | undefined>,
  load: {
    list: (range: ReturnType<typeof rangeOpts>, limit: number, offset: number) => DexTradeRow[];
    count: (range: ReturnType<typeof rangeOpts>) => number;
  },
): {
  data: ReturnType<typeof tradeFromRow>[];
  meta: Record<string, number>;
} {
  const page = query.page === undefined ? undefined : parsePage(query.page);
  const perPage = parsePerPage(query.per_page);
  const limit = page === undefined ? parseLimit(query.limit) : perPage;
  const offset = page === undefined ? 0 : (page - 1) * perPage;
  const range = rangeOpts(query);
  const rows = load.list(range, limit, offset);
  const start = readHistoryStartLedger(db);
  return {
    data: rows.map((row) => tradeFromRow(row)),
    meta: {
      count: load.count(range),
      ...(page === undefined ? {} : { page, per_page: perPage }),
      ledger_index: getLatestLedgerIndex(db),
      ...(start === null ? {} : { history_start_ledger: start }),
    },
  };
}
