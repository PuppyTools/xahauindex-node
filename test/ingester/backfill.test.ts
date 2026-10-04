import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { listDexTrades, listOhlcvCandles } from '../../src/db/queries/dex.js';
import { getIndexerState, getLatestLedgerIndex, setIndexerState, upsertLedger } from '../../src/db/queries/indexer.js';
import { getToken, getTrustLine, upsertTrustLine } from '../../src/db/queries/tokens.js';
import { getUriToken, listUriTokenTransfers, upsertUriToken } from '../../src/db/queries/uritokens.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { runBackfill } from '../../src/ingester/backfill.js';
import { runDedicatedBackfill } from '../../src/ingester/index.js';
import { applyClosedLedger, applyHistoricalLedger } from '../../src/ingester/ledger.js';
import type { ClosedLedger } from '../../src/ingester/source.js';
import { silentLog, testConfig } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const BUYER = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH';
const MAKER = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH';
const URI_ID = 'A'.repeat(64);
const MISSING_URI = 'B'.repeat(64);
const RIPPLE_INDEX = 'C'.repeat(64);
const URI_HEX = Buffer.from('https://nft.example/1').toString('hex');

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

function closedLedger(index: number, transactions: unknown[]): ClosedLedger {
  return {
    index,
    hash: index.toString(16).padStart(64, '0'),
    closeTime: 1_700_000_000 + index,
    transactions,
  };
}

function seedSnapshot(db: SqliteDatabase, ledger: number): void {
  setIndexerState(db, 'snapshot_status', 'complete');
  setIndexerState(db, 'snapshot_ledger', String(ledger));
  setIndexerState(db, 'live_from_ledger', String(ledger + 1));
  upsertLedger(db, {
    ledger_index: ledger,
    close_time: 1_700_000_000 + ledger,
    hash: 'f'.repeat(64),
    tx_count: 0,
    indexed_at: 1_700_000_000,
  });
}

function ripplePayment(hash: string, balance: string): unknown {
  return {
    hash,
    TransactionType: 'Payment',
    Account: ISSUER,
    meta: {
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [
        {
          ModifiedNode: {
            LedgerEntryType: 'RippleState',
            LedgerIndex: RIPPLE_INDEX,
            FinalFields: {
              Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: balance },
              LowLimit: { currency: 'USD', issuer: ISSUER, value: '0' },
              HighLimit: { currency: 'USD', issuer: HOLDER, value: '100' },
              Flags: 0,
            },
          },
        },
      ],
    },
  };
}

function offerTake(hash: string): unknown {
  return {
    hash,
    TransactionType: 'OfferCreate',
    Account: HOLDER,
    meta: {
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [
        {
          ModifiedNode: {
            LedgerEntryType: 'Offer',
            LedgerIndex: hash.replace(/0/g, 'e').slice(0, 64).padEnd(64, 'e'),
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
  };
}

function uriFields(owner: string): Record<string, unknown> {
  return {
    URI: URI_HEX,
    Issuer: ISSUER,
    Owner: owner,
    Digest: 'E'.repeat(64),
    Flags: 0,
  };
}

describe('applyHistoricalLedger', () => {
  it('records trades and transfers without rewriting snapshot balances or owners', () => {
    const db = memoryDb();
    seedSnapshot(db, 50);
    upsertTrustLine(db, {
      id: `${HOLDER}:USD:${ISSUER}`,
      account: HOLDER,
      currency: 'USD',
      issuer: ISSUER,
      balance: '25',
      limit_peer: '100',
      quality_in: null,
      quality_out: null,
      flags: 0,
      first_ledger: 50,
      last_updated: 50,
    });
    upsertUriToken(db, {
      id: URI_ID,
      uri: 'https://nft.example/1',
      uri_raw: URI_HEX,
      digest: 'E'.repeat(64),
      issuer: ISSUER,
      owner: BUYER,
      flags: 0,
      sell_offer: null,
      destination: null,
      burned: 0,
      burn_ledger: null,
      mint_ledger: 10,
      last_updated: 50,
      icon_url: null,
      uri_metadata: null,
      uri_meta_checked_ledger: null,
    });

    const historical = applyHistoricalLedger(
      db,
      closedLedger(40, [
        ripplePayment('1'.repeat(64), '-99'),
        offerTake('2'.repeat(64)),
        {
          hash: '3'.repeat(64),
          TransactionType: 'URITokenBuy',
          Account: HOLDER,
          Amount: '1000000',
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                ModifiedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: URI_ID,
                  FinalFields: uriFields(HOLDER),
                  PreviousFields: { Owner: ISSUER },
                },
              },
            ],
          },
        },
        {
          hash: '4'.repeat(64),
          TransactionType: 'URITokenBurn',
          Account: HOLDER,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                DeletedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: URI_ID,
                  FinalFields: uriFields(HOLDER),
                },
              },
            ],
          },
        },
        {
          hash: '5'.repeat(64),
          TransactionType: 'URITokenMint',
          Account: ISSUER,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                CreatedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: MISSING_URI,
                  NewFields: uriFields(ISSUER),
                },
              },
            ],
          },
        },
        {
          hash: '6'.repeat(64),
          TransactionType: 'URITokenBurn',
          Account: ISSUER,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                DeletedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: MISSING_URI,
                  FinalFields: uriFields(ISSUER),
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );

    assert.equal(historical.applied, true);
    assert.equal(historical.tokenIds.length, 0);
    assert.equal(getTrustLine(db, `${HOLDER}:USD:${ISSUER}`)?.balance, '25');
    assert.equal(getToken(db, `USD:${ISSUER}`), undefined);

    const existing = getUriToken(db, URI_ID);
    assert.ok(existing);
    assert.equal(existing.owner, BUYER);
    assert.equal(existing.burned, 0);
    const transfers = listUriTokenTransfers(db, URI_ID);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0]?.from_account, ISSUER);
    assert.equal(transfers[0]?.to_account, HOLDER);

    const burned = getUriToken(db, MISSING_URI);
    assert.ok(burned);
    assert.equal(burned.burned, 1);
    assert.equal(burned.burn_ledger, 40);

    const pair = {
      baseCurrency: 'USD',
      baseIssuer: ISSUER,
      counterCurrency: 'XAH',
      counterIssuer: null,
    };
    assert.equal(listDexTrades(db, pair, { limit: 10 }).length, 1);
    assert.equal(listOhlcvCandles(db, pair, { period: '1h', limit: 10 }).length, 1);

    const replay = applyHistoricalLedger(
      db,
      closedLedger(40, [offerTake('2'.repeat(64))]),
      silentLog,
    );
    assert.equal(replay.applied, true);
    assert.equal(listDexTrades(db, pair, { limit: 10 }).length, 1);
    assert.equal(listOhlcvCandles(db, pair, { period: '1h', limit: 10 })[0]?.trade_count, 1);

    assert.equal(getLatestLedgerIndex(db), 50);
    const liveSkip = applyClosedLedger(db, closedLedger(40, [offerTake('7'.repeat(64))]), silentLog);
    assert.equal(liveSkip.reason, 'already_indexed');
  });
});

describe('runBackfill', () => {
  it('does nothing when backfill env is unset', async () => {
    const db = memoryDb();
    seedSnapshot(db, 10);
    const requested: number[] = [];
    const result = await runBackfill({
      db,
      config: testConfig(),
      log: silentLog,
      source: {
        getLedgerWithTransactions: async (index) => {
          requested.push(index);
          return closedLedger(index, []);
        },
      },
    });
    assert.equal(result.skipped, true);
    assert.deepEqual(requested, []);
    assert.equal(getIndexerState(db, 'backfill_status'), undefined);
  });

  it('walks FROM through the snapshot, skips missing ledgers, and resumes', async () => {
    const db = memoryDb();
    seedSnapshot(db, 10);
    const requested: number[] = [];
    const result = await runBackfill({
      db,
      config: testConfig({ backfillFromLedger: 8 }),
      log: silentLog,
      fetchAttempts: 2,
      retryMinMs: 1,
      source: {
        getLedgerWithTransactions: async (index) => {
          requested.push(index);
          if (index === 9) {
            throw new Error('ledger not found');
          }
          return closedLedger(index, index === 8 ? [offerTake('a'.repeat(64))] : []);
        },
      },
    });
    assert.equal(result.skipped, false);
    assert.equal(result.from, 8);
    assert.equal(result.through, 10);
    assert.equal(result.applied, 2);
    assert.equal(result.skippedLedgers, 1);
    assert.deepEqual(requested, [8, 9, 9, 10]);
    assert.equal(getIndexerState(db, 'backfill_status'), 'complete');
    assert.equal(getIndexerState(db, 'backfill_from'), '8');
    assert.equal(getIndexerState(db, 'backfill_next'), '11');
    assert.equal(getLatestLedgerIndex(db), 10);
    assert.equal(
      listDexTrades(
        db,
        { baseCurrency: 'USD', baseIssuer: ISSUER, counterCurrency: 'XAH', counterIssuer: null },
        { limit: 10 },
      ).length,
      1,
    );

    requested.length = 0;
    const again = await runBackfill({
      db,
      config: testConfig({ backfillFromLedger: 8 }),
      log: silentLog,
      source: {
        getLedgerWithTransactions: async (index) => {
          requested.push(index);
          return closedLedger(index, []);
        },
      },
    });
    assert.equal(again.skipped, true);
    assert.deepEqual(requested, []);

    setIndexerState(db, 'backfill_status', 'running');
    setIndexerState(db, 'backfill_next', '10');
    requested.length = 0;
    const resumed = await runBackfill({
      db,
      config: testConfig({ backfillFromLedger: 8 }),
      log: silentLog,
      source: {
        getLedgerWithTransactions: async (index) => {
          requested.push(index);
          return closedLedger(index, []);
        },
      },
    });
    assert.equal(resumed.skipped, false);
    assert.deepEqual(requested, [10]);
    assert.equal(getIndexerState(db, 'backfill_status'), 'complete');
  });
});

describe('runDedicatedBackfill', () => {
  it('keeps live subscribe on XAHAUD_URL and fetches history from JSON-RPC', async () => {
    const requested: number[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => {
        chunks.push(chunk);
      });
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as {
          params: Array<{ ledger_index: number }>;
        };
        const index = body.params[0]?.ledger_index ?? 0;
        requested.push(index);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            result: {
              status: 'success',
              ledger_index: index,
              ledger_hash: 'a'.repeat(64),
              ledger: {
                ledger_index: index,
                close_time: 738_000_000,
                transactions: [],
              },
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    const db = memoryDb();
    seedSnapshot(db, 12);
    try {
      const result = await runDedicatedBackfill({
        db,
        liveSource: {
          getLedgerWithTransactions: async () => {
            throw new Error('live node should not serve backfill');
          },
        },
        config: testConfig({
          xahaudUrl: 'wss://live.example',
          backfillFromLedger: 11,
          backfillXahaudUrl: `http://127.0.0.1:${port}`,
        }),
        log: silentLog,
      });
      assert.equal(result.skipped, false);
      assert.deepEqual(requested, [11, 12]);
      assert.equal(getIndexerState(db, 'backfill_status'), 'complete');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
