import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { setIndexerState } from '../../src/db/queries/indexer.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import { silentLog, testConfig, testRuntime } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const MAKER = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH';
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

function seedTokenLedger(db: SqliteDatabase): void {
  applyClosedLedger(
    db,
    {
      index: 51,
      hash: '1'.repeat(64),
      closeTime: HOUR,
      transactions: [
        {
          hash: 'a'.repeat(64),
          TransactionType: 'TrustSet',
          Account: HOLDER,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                CreatedNode: {
                  LedgerEntryType: 'RippleState',
                  LedgerIndex: 'c'.repeat(64),
                  NewFields: {
                    Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-25' },
                    LowLimit: { currency: 'USD', issuer: ISSUER, value: '0' },
                    HighLimit: { currency: 'USD', issuer: HOLDER, value: '100' },
                    Flags: 0,
                  },
                },
              },
            ],
          },
        },
      ],
    },
    silentLog,
  );
}

function seedTrade(db: SqliteDatabase, index: number, closeTime: number, hash: string): void {
  applyClosedLedger(
    db,
    {
      index,
      hash: index.toString(16).padStart(64, '0'),
      closeTime,
      transactions: [
        {
          hash,
          TransactionType: 'OfferCreate',
          Account: HOLDER,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                ModifiedNode: {
                  LedgerEntryType: 'Offer',
                  LedgerIndex: hash.replace(/a/g, 'b'),
                  FinalFields: {
                    Account: MAKER,
                    TakerGets: '1000000',
                    TakerPays: { currency: 'USD', issuer: ISSUER, value: '1' },
                  },
                  PreviousFields: {
                    TakerGets: '2000000',
                    TakerPays: { currency: 'USD', issuer: ISSUER, value: '2' },
                  },
                },
              },
            ],
          },
        },
      ],
    },
    silentLog,
  );
}

describe('holders, prices, and trades routes', () => {
  it('lists nonzero holders for a token', async () => {
    const db = memoryDb();
    seedTokenLedger(db);
    const app = await buildApi({ db, config: testConfig(), runtime: testRuntime({ networkLedgerIndex: 51 }) });
    const missing = await app.inject({ method: 'GET', url: `/v1/tokens/USD/${ISSUER}/holders` });
    assert.equal(missing.statusCode, 200);
    assert.equal(missing.json().data.length, 1);
    assert.equal(missing.json().data[0].account, HOLDER);
    assert.equal(missing.json().data[0].balance, '25');
    assert.equal(missing.json().meta.count, 1);
    await app.close();
  });

  it('returns OHLCV and trades for a pair, and 400 without an IOU issuer', async () => {
    const db = memoryDb();
    setIndexerState(db, 'live_from_ledger', '51');
    seedTrade(db, 51, HOUR - 60, 'a'.repeat(64));
    seedTrade(db, 52, HOUR + 10, 'c'.repeat(64));
    const app = await buildApi({ db, config: testConfig(), runtime: testRuntime({ networkLedgerIndex: 52 }) });

    const bad = await app.inject({ method: 'GET', url: '/v1/prices/USD/XAH' });
    assert.equal(bad.statusCode, 400);

    const prices = await app.inject({
      method: 'GET',
      url: `/v1/prices/USD/XAH?base_issuer=${ISSUER}&period=1h`,
    });
    assert.equal(prices.statusCode, 200);
    assert.equal(prices.json().data.length, 2);
    assert.equal(prices.json().meta.history_start_ledger, 51);

    const ranged = await app.inject({
      method: 'GET',
      url: `/v1/prices/USD/XAH?base_issuer=${ISSUER}&period=1h&from=${HOUR}`,
    });
    assert.equal(ranged.json().data.length, 1);

    const trades = await app.inject({
      method: 'GET',
      url: `/v1/trades/XAH/USD?counter_issuer=${ISSUER}&from_ledger=52&to_ledger=52`,
    });
    assert.equal(trades.statusCode, 200);
    assert.equal(trades.json().data.length, 1);
    assert.equal(trades.json().data[0].tx_hash, 'c'.repeat(64));

    const token = await app.inject({ method: 'GET', url: `/v1/tokens/USD/${ISSUER}` });
    // token row may not exist from offer-only ledgers
    assert.ok(token.statusCode === 200 || token.statusCode === 404);
    await app.close();
  });
});
