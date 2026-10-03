import type { DexTradeRow, OhlcvCandleRow, OhlcvPeriod } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

export interface PairKey {
  baseCurrency: string;
  baseIssuer: string | null;
  counterCurrency: string;
  counterIssuer: string | null;
}

function pairParams(pair: PairKey): Record<string, string | number | null> {
  return {
    base_currency: pair.baseCurrency,
    base_issuer: pair.baseIssuer,
    counter_currency: pair.counterCurrency,
    counter_issuer: pair.counterIssuer,
  };
}

export function insertDexTrade(db: SqliteDatabase, row: Omit<DexTradeRow, 'id'>): void {
  db.prepare(
    `
    INSERT INTO dex_trades (
      base_currency, base_issuer, counter_currency, counter_issuer, price,
      base_amount, counter_amount, taker, maker, ledger_index, close_time, tx_hash
    ) VALUES (
      @base_currency, @base_issuer, @counter_currency, @counter_issuer, @price,
      @base_amount, @counter_amount, @taker, @maker, @ledger_index, @close_time, @tx_hash
    )
    `,
  ).run(row);
}

export function listDexTrades(
  db: SqliteDatabase,
  pair: PairKey,
  opts: {
    from?: number;
    to?: number;
    fromLedger?: number;
    toLedger?: number;
    limit: number;
  },
): DexTradeRow[] {
  const where = ['base_currency = @base_currency', 'counter_currency = @counter_currency'];
  const params: Record<string, string | number | null> = {
    ...pairParams(pair),
    limit: opts.limit,
  };
  where.push('ifnull(base_issuer, \'\') = ifnull(@base_issuer, \'\')');
  where.push('ifnull(counter_issuer, \'\') = ifnull(@counter_issuer, \'\')');
  if (opts.from !== undefined) {
    where.push('close_time >= @from');
    params.from = opts.from;
  }
  if (opts.to !== undefined) {
    where.push('close_time < @to');
    params.to = opts.to;
  }
  if (opts.fromLedger !== undefined) {
    where.push('ledger_index >= @from_ledger');
    params.from_ledger = opts.fromLedger;
  }
  if (opts.toLedger !== undefined) {
    where.push('ledger_index <= @to_ledger');
    params.to_ledger = opts.toLedger;
  }
  return db
    .prepare(
      `
      SELECT * FROM dex_trades
      WHERE ${where.join(' AND ')}
      ORDER BY close_time DESC, id DESC
      LIMIT @limit
      `,
    )
    .all(params) as DexTradeRow[];
}

export function upsertOhlcvCandle(db: SqliteDatabase, row: Omit<OhlcvCandleRow, 'id'>): void {
  db.prepare(
    `
    INSERT INTO ohlcv_candles (
      base_currency, base_issuer, counter_currency, counter_issuer, period,
      open_time, open_ledger, close_ledger, open, high, low, close, volume, trade_count
    ) VALUES (
      @base_currency, @base_issuer, @counter_currency, @counter_issuer, @period,
      @open_time, @open_ledger, @close_ledger, @open, @high, @low, @close, @volume, @trade_count
    )
    ON CONFLICT(base_currency, base_issuer_key, counter_currency, counter_issuer_key, period, open_time)
    DO UPDATE SET
      open_ledger = excluded.open_ledger,
      close_ledger = excluded.close_ledger,
      open = excluded.open,
      high = excluded.high,
      low = excluded.low,
      close = excluded.close,
      volume = excluded.volume,
      trade_count = excluded.trade_count
    `,
  ).run(row);
}

export function listOhlcvCandles(
  db: SqliteDatabase,
  pair: PairKey,
  opts: {
    period: OhlcvPeriod;
    from?: number;
    to?: number;
    fromLedger?: number;
    toLedger?: number;
    limit: number;
  },
): OhlcvCandleRow[] {
  const where = [
    'base_currency = @base_currency',
    'counter_currency = @counter_currency',
    'period = @period',
    'ifnull(base_issuer, \'\') = ifnull(@base_issuer, \'\')',
    'ifnull(counter_issuer, \'\') = ifnull(@counter_issuer, \'\')',
  ];
  const params: Record<string, string | number | null> = {
    ...pairParams(pair),
    period: opts.period,
    limit: opts.limit,
  };
  if (opts.from !== undefined) {
    where.push('open_time >= @from');
    params.from = opts.from;
  }
  if (opts.to !== undefined) {
    where.push('open_time < @to');
    params.to = opts.to;
  }
  if (opts.fromLedger !== undefined) {
    where.push('ifnull(close_ledger, open_ledger) >= @from_ledger');
    params.from_ledger = opts.fromLedger;
  }
  if (opts.toLedger !== undefined) {
    where.push('ifnull(open_ledger, 0) <= @to_ledger');
    params.to_ledger = opts.toLedger;
  }
  return db
    .prepare(
      `
      SELECT * FROM ohlcv_candles
      WHERE ${where.join(' AND ')}
      ORDER BY open_time DESC
      LIMIT @limit
      `,
    )
    .all(params) as OhlcvCandleRow[];
}
