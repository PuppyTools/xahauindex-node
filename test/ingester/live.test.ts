import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { getLatestLedgerIndex, setIndexerState, upsertLedger } from '../../src/db/queries/indexer.js';
import { catchUpLedgers, followLive } from '../../src/ingester/live.js';
import type { ClosedLedger, LiveLedgerSource, ValidatedLedger } from '../../src/ingester/source.js';
import { silentLog, testRuntime } from '../helpers.js';

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

function seedLiveFrom(db: SqliteDatabase, last: number): void {
  setIndexerState(db, 'snapshot_status', 'complete');
  setIndexerState(db, 'snapshot_ledger', String(last));
  setIndexerState(db, 'live_from_ledger', String(last + 1));
  upsertLedger(db, {
    ledger_index: last,
    close_time: 1_700_000_000,
    hash: 'f'.repeat(64),
    tx_count: 0,
    indexed_at: 1_700_000_000,
  });
}

async function waitUntil(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('timed out waiting for live ingest');
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

function emptyLedger(index: number): ClosedLedger {
  return {
    index,
    hash: index.toString(16).padStart(64, '0'),
    closeTime: 1_700_000_000 + index,
    transactions: [],
  };
}

describe('catchUpLedgers', () => {
  it('fills every ledger from last+1 through the tip', async () => {
    const db = memoryDb();
    seedLiveFrom(db, 10);
    const requested: number[] = [];
    const source = {
      getLedgerWithTransactions: async (index: number) => {
        requested.push(index);
        return emptyLedger(index);
      },
    };

    const results = await catchUpLedgers({
      db,
      source,
      log: silentLog,
      through: 13,
    });
    assert.deepEqual(requested, [11, 12, 13]);
    assert.equal(results.length, 3);
    assert.ok(results.every((row) => row.applied));
    assert.equal(getLatestLedgerIndex(db), 13);
  });

  it('does not rewind live when historical ledgers sit below the snapshot', async () => {
    const db = memoryDb();
    seedLiveFrom(db, 10);
    upsertLedger(db, {
      ledger_index: 8,
      close_time: 1_700_000_008,
      hash: '8'.repeat(64),
      tx_count: 0,
      indexed_at: 1_700_000_008,
    });
    const requested: number[] = [];
    await catchUpLedgers({
      db,
      source: {
        getLedgerWithTransactions: async (index) => {
          requested.push(index);
          return emptyLedger(index);
        },
      },
      log: silentLog,
      through: 12,
    });
    assert.deepEqual(requested, [11, 12]);
    assert.equal(getLatestLedgerIndex(db), 12);
  });
});

describe('followLive', () => {
  it('catches up then applies a later ledgerClosed gap', async () => {
    const db = memoryDb();
    seedLiveFrom(db, 10);
    const requested: number[] = [];
    const handlers: Array<(ledger: ValidatedLedger) => void> = [];
    const source: LiveLedgerSource = {
      getValidatedLedger: async () => ({
        index: 12,
        hash: 'a'.repeat(64),
        closeTime: 1_700_000_012,
      }),
      getLedgerDataPage: async () => ({ state: [] }),
      getLedgerWithTransactions: async (index) => {
        requested.push(index);
        return emptyLedger(index);
      },
      subscribeLedgers: async () => undefined,
      onLedgerClosed: (handler) => {
        handlers.push(handler);
        return () => {
          const at = handlers.indexOf(handler);
          if (at >= 0) {
            handlers.splice(at, 1);
          }
        };
      },
    };

    const controller = new AbortController();
    const runtime = testRuntime();
    const running = followLive({
      db,
      source,
      runtime,
      log: silentLog,
      signal: controller.signal,
    });

    await waitUntil(() => requested.length >= 2 && handlers.length > 0);
    assert.deepEqual(requested, [11, 12]);
    assert.equal(runtime.networkLedgerIndex, 12);

    handlers[0]?.({ index: 14, hash: 'b'.repeat(64), closeTime: 1_700_000_014 });
    await waitUntil(() => requested.length >= 4);
    assert.deepEqual(requested, [11, 12, 13, 14]);
    assert.equal(getLatestLedgerIndex(db), 14);

    controller.abort();
    await running;
  });
});
