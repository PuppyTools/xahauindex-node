import type { FastifyPluginAsync } from 'fastify';

import { getIndexerState, getLatestLedgerIndex } from '../../db/queries/indexer.js';
import { countDexTrades, listDexTrades, listOhlcvCandles } from '../../db/queries/dex.js';
import type { OhlcvPeriod } from '../../types/db.js';
import { candleFromRow, tradeFromRow } from '../mappers.js';
import { parseRequestedPair } from '../pair.js';
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

function historyStart(db: Parameters<typeof getIndexerState>[0]): number | null {
  const raw = getIndexerState(db, 'live_from_ledger');
  if (raw === undefined) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
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
    const start = historyStart(app.db);
    return {
      data: rows.map((row) => candleFromRow(row)),
      meta: {
        count: rows.length,
        ledger_index: getLatestLedgerIndex(app.db),
        ...(start === null ? {} : { history_start_ledger: start }),
      },
    };
  });

  app.get('/v1/trades/:base/:counter', async (request) => {
    const params = request.params as { base: string; counter: string };
    const query = asQuery(request.query);
    const pair = parseRequestedPair(params.base, params.counter, query.base_issuer, query.counter_issuer);
    const page = query.page === undefined ? undefined : parsePage(query.page);
    const perPage = parsePerPage(query.per_page);
    const limit = page === undefined ? parseLimit(query.limit) : perPage;
    const offset = page === undefined ? 0 : (page - 1) * perPage;
    const range = rangeOpts(query);
    const rows = listDexTrades(app.db, pair.stored, {
      ...range,
      limit,
      offset,
    });
    const start = historyStart(app.db);
    return {
      data: rows.map((row) => tradeFromRow(row)),
      meta: {
        count: countDexTrades(app.db, pair.stored, range),
        ...(page === undefined ? {} : { page, per_page: perPage }),
        ledger_index: getLatestLedgerIndex(app.db),
        ...(start === null ? {} : { history_start_ledger: start }),
      },
    };
  });
};
