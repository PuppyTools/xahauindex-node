import type { SqliteDatabase } from '../db/client.js';
import {
  insertDexTrade,
  listOhlcvCandles,
  upsertOhlcvCandle,
  type PairKey,
} from '../db/queries/dex.js';
import type { DexTradeRow, OhlcvPeriod } from '../types/db.js';
import type { Amount } from '../types/xahau.js';
import {
  addDecimal,
  decodeCurrency,
  dropsToXah,
  isZeroDecimal,
  normalizePair,
  subtractDecimal,
  type CurrencySide,
} from '../util/xahau.js';
import { parseAmount, type ParsedAffectedNode, type ParsedLedgerTx } from './guards.js';
import type { ApplyLogger } from './objects.js';

const PERIODS: readonly OhlcvPeriod[] = ['1h', '24h', '7d'];

export function candleOpenTime(unixSeconds: number, period: OhlcvPeriod): number {
  if (period === '1h') {
    return Math.floor(unixSeconds / 3600) * 3600;
  }
  if (period === '24h') {
    return Math.floor(unixSeconds / 86400) * 86400;
  }
  return Math.floor(unixSeconds / 604800) * 604800;
}

interface SizedSide {
  side: CurrencySide;
  qty: string;
}

function sizedSide(amount: Amount): SizedSide | null {
  if (typeof amount === 'string') {
    return {
      side: { currency: 'XAH', issuer: null },
      qty: dropsToXah(amount),
    };
  }
  const decoded = decodeCurrency(amount.currency);
  return {
    side: { currency: decoded.currency, issuer: amount.issuer },
    qty: amount.value,
  };
}

function consumedSide(previous: Amount | undefined, final: Amount | undefined): SizedSide | null {
  if (previous === undefined) {
    return null;
  }
  const start = sizedSide(previous);
  if (!start) {
    return null;
  }
  if (final === undefined) {
    return start;
  }
  const end = sizedSide(final);
  if (!end || start.side.currency !== end.side.currency || start.side.issuer !== end.side.issuer) {
    return null;
  }
  const qty = subtractDecimal(start.qty, end.qty);
  if (isZeroDecimal(qty) || qty.startsWith('-')) {
    return null;
  }
  return { side: start.side, qty };
}

export function extractExecutedTrades(
  tx: ParsedLedgerTx,
  nodes: ParsedAffectedNode[],
  ledgerIndex: number,
  closeTime: number,
  log: ApplyLogger,
): Array<Omit<DexTradeRow, 'id'>> {
  if (tx.hash === '') {
    return [];
  }
  const trades: Array<Omit<DexTradeRow, 'id'>> = [];
  for (const node of nodes) {
    if (node.type !== 'Offer' || node.kind === 'created') {
      continue;
    }
    const previousGets = parseAmount(node.previous?.TakerGets);
    const previousPays = parseAmount(node.previous?.TakerPays);
    if (previousGets === undefined && previousPays === undefined) {
      continue;
    }
    const gets = consumedSide(previousGets, parseAmount(node.fields.TakerGets));
    const pays = consumedSide(previousPays, parseAmount(node.fields.TakerPays));
    if (!gets || !pays) {
      continue;
    }
    const maker = typeof node.fields.Account === 'string' ? node.fields.Account : undefined;
    if (!maker) {
      log.warn({ hash: tx.hash, index: node.index }, 'skipping offer take without maker');
      continue;
    }
    const pair = normalizePair(gets.side, pays.side);
    const baseAmount = pair.inverted ? pays.qty : gets.qty;
    const counterAmount = pair.inverted ? gets.qty : pays.qty;
    const baseNumber = Number(baseAmount);
    const counterNumber = Number(counterAmount);
    if (!Number.isFinite(baseNumber) || baseNumber <= 0 || !Number.isFinite(counterNumber)) {
      log.warn({ hash: tx.hash, index: node.index }, 'skipping offer take with non-numeric size');
      continue;
    }
    trades.push({
      base_currency: pair.base.currency,
      base_issuer: pair.base.issuer,
      counter_currency: pair.counter.currency,
      counter_issuer: pair.counter.issuer,
      price: counterNumber / baseNumber,
      base_amount: baseAmount,
      counter_amount: counterAmount,
      taker: tx.account,
      maker,
      ledger_index: ledgerIndex,
      close_time: closeTime,
      tx_hash: tx.hash,
    });
  }
  return trades;
}

function pairFromTrade(trade: Omit<DexTradeRow, 'id'>): PairKey {
  return {
    baseCurrency: trade.base_currency,
    baseIssuer: trade.base_issuer,
    counterCurrency: trade.counter_currency,
    counterIssuer: trade.counter_issuer,
  };
}

export function applyTradeToCandles(db: SqliteDatabase, trade: Omit<DexTradeRow, 'id'>): void {
  const pair = pairFromTrade(trade);
  for (const period of PERIODS) {
    const openTime = candleOpenTime(trade.close_time, period);
    const existing = listOhlcvCandles(db, pair, { period, from: openTime, to: openTime + 1, limit: 1 })[0];
    if (!existing) {
      upsertOhlcvCandle(db, {
        base_currency: trade.base_currency,
        base_issuer: trade.base_issuer,
        counter_currency: trade.counter_currency,
        counter_issuer: trade.counter_issuer,
        period,
        open_time: openTime,
        open_ledger: trade.ledger_index,
        close_ledger: trade.ledger_index,
        open: trade.price,
        high: trade.price,
        low: trade.price,
        close: trade.price,
        volume: trade.base_amount,
        trade_count: 1,
      });
      continue;
    }
    upsertOhlcvCandle(db, {
      base_currency: existing.base_currency,
      base_issuer: existing.base_issuer,
      counter_currency: existing.counter_currency,
      counter_issuer: existing.counter_issuer,
      period: existing.period,
      open_time: existing.open_time,
      open_ledger: existing.open_ledger ?? trade.ledger_index,
      close_ledger: trade.ledger_index,
      open: existing.open,
      high: Math.max(existing.high, trade.price),
      low: Math.min(existing.low, trade.price),
      close: trade.price,
      volume: addDecimal(existing.volume, trade.base_amount),
      trade_count: existing.trade_count + 1,
    });
  }
}

export function applyExecutedOffers(
  db: SqliteDatabase,
  tx: ParsedLedgerTx,
  nodes: ParsedAffectedNode[],
  ledgerIndex: number,
  closeTime: number,
  log: ApplyLogger,
): number {
  const trades = extractExecutedTrades(tx, nodes, ledgerIndex, closeTime, log);
  for (const trade of trades) {
    insertDexTrade(db, trade);
    applyTradeToCandles(db, trade);
  }
  return trades.length;
}
