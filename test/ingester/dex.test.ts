import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { listDexTrades, listOhlcvCandles } from '../../src/db/queries/dex.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import { candleOpenTime } from '../../src/ingester/dex.js';
import { silentLog } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const MAKER = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH';
const TAKER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const HOUR = 1_700_006_400;

const dbs: SqliteDatabase[] = [];

function memoryDb(): SqliteDatabase {
  const db = openDatabase(':memory:');
  dbs.push(db);
  return db;
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeDatabase(db);
  }
});

const pair = {
  baseCurrency: 'USD',
  baseIssuer: ISSUER,
  counterCurrency: 'XAH',
  counterIssuer: null,
};

function usd(value: string) {
  return { currency: 'USD', issuer: ISSUER, value };
}

function offerTake(opts: {
  hash: string;
  remainingGets: string;
  remainingPays: string;
  previousGets: string;
  previousPays: string;
  deleted?: boolean;
}) {
  const fields = {
    Account: MAKER,
    TakerGets: opts.remainingGets,
    TakerPays: usd(opts.remainingPays),
  };
  const previous = {
    TakerGets: opts.previousGets,
    TakerPays: usd(opts.previousPays),
  };
  const node = opts.deleted
    ? {
        DeletedNode: {
          LedgerEntryType: 'Offer',
          LedgerIndex: opts.hash.replace(/0/g, 'f').slice(0, 64).padEnd(64, 'f'),
          FinalFields: fields,
          PreviousFields: previous,
        },
      }
    : {
        ModifiedNode: {
          LedgerEntryType: 'Offer',
          LedgerIndex: opts.hash.replace(/0/g, 'e').slice(0, 64).padEnd(64, 'e'),
          FinalFields: fields,
          PreviousFields: previous,
        },
      };
  return {
    hash: opts.hash,
    TransactionType: 'OfferCreate',
    Account: TAKER,
    meta: {
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [node],
    },
  };
}

function ledger(index: number, closeTime: number, transactions: unknown[]) {
  return {
    index,
    hash: index.toString(16).padStart(64, '0'),
    closeTime,
    transactions,
  };
}

describe('DEX trades and candles', () => {
  it('creates two 1h candles across an hour boundary and honors range filters', () => {
    assert.equal(HOUR % 3600, 0);
    assert.equal(candleOpenTime(HOUR - 60, '1h'), HOUR - 3600);
    assert.equal(candleOpenTime(HOUR + 10, '1h'), HOUR);

    const db = memoryDb();
    applyClosedLedger(
      db,
      ledger(51, HOUR - 60, [
        offerTake({
          hash: '1'.repeat(64),
          previousGets: '2000000',
          previousPays: '2',
          remainingGets: '1000000',
          remainingPays: '1',
        }),
      ]),
      silentLog,
    );
    applyClosedLedger(
      db,
      ledger(52, HOUR - 10, [
        offerTake({
          hash: '2'.repeat(64),
          previousGets: '3000000',
          previousPays: '6',
          remainingGets: '2000000',
          remainingPays: '4',
        }),
      ]),
      silentLog,
    );
    applyClosedLedger(
      db,
      ledger(53, HOUR + 10, [
        offerTake({
          hash: '3'.repeat(64),
          previousGets: '1000000',
          previousPays: '2',
          remainingGets: '0',
          remainingPays: '0',
          deleted: true,
        }),
      ]),
      silentLog,
    );

    const trades = listDexTrades(db, pair, { limit: 10 });
    assert.equal(trades.length, 3);
    assert.equal(trades[0]?.ledger_index, 53);
    assert.equal(trades[2]?.base_amount, '1');
    assert.equal(trades[2]?.counter_amount, '1');
    assert.equal(trades[2]?.price, 1);

    const hourCandles = listOhlcvCandles(db, pair, { period: '1h', limit: 10 });
    assert.equal(hourCandles.length, 2);
    const firstHour = hourCandles.find((row) => row.open_time === HOUR - 3600);
    const secondHour = hourCandles.find((row) => row.open_time === HOUR);
    assert.ok(firstHour);
    assert.ok(secondHour);
    assert.equal(firstHour.trade_count, 2);
    assert.equal(firstHour.volume, '3');
    assert.equal(firstHour.open, 1);
    assert.equal(firstHour.close, 0.5);
    assert.equal(firstHour.high, 1);
    assert.equal(secondHour.trade_count, 1);
    assert.equal(secondHour.volume, '2');
    assert.equal(secondHour.close, 0.5);

    const fromHour = listOhlcvCandles(db, pair, { period: '1h', from: HOUR, limit: 10 });
    assert.equal(fromHour.length, 1);
    assert.equal(fromHour[0]?.open_time, HOUR);

    const ledgerRange = listOhlcvCandles(db, pair, {
      period: '1h',
      fromLedger: 53,
      toLedger: 53,
      limit: 10,
    });
    assert.equal(ledgerRange.length, 1);
    assert.equal(ledgerRange[0]?.open_time, HOUR);

    const tradeRange = listDexTrades(db, pair, { fromLedger: 52, toLedger: 52, limit: 10 });
    assert.equal(tradeRange.length, 1);
    assert.equal(tradeRange[0]?.tx_hash, '2'.repeat(64));
  });

  it('ignores offer cancels that do not consume amounts', () => {
    const db = memoryDb();
    applyClosedLedger(
      db,
      ledger(51, HOUR, [
        {
          hash: '4'.repeat(64),
          TransactionType: 'OfferDelete',
          Account: MAKER,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                DeletedNode: {
                  LedgerEntryType: 'Offer',
                  LedgerIndex: '5'.repeat(64),
                  FinalFields: {
                    Account: MAKER,
                    TakerGets: '1000000',
                    TakerPays: usd('1'),
                  },
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );
    assert.equal(listDexTrades(db, pair, { limit: 10 }).length, 0);
    assert.equal(listOhlcvCandles(db, pair, { period: '1h', limit: 10 }).length, 0);
  });
});
