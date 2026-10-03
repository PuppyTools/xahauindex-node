import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { setIndexerState } from '../../src/db/queries/indexer.js';
import { upsertIssuer } from '../../src/db/queries/issuers.js';
import { upsertToken } from '../../src/db/queries/tokens.js';
import type { Status } from '../../src/types/api.js';
import { sampleIssuer, sampleToken, testConfig, testRuntime } from '../helpers.js';

const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeDatabase(db);
  }
});

describe('GET /v1/status', () => {
  it('returns a syncing envelope on an empty database', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ startedAt: Date.now() - 2_000 }),
    });

    const response = await app.inject({ method: 'GET', url: '/v1/status' });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { data: Status; meta: { ledger_index: number } };
    assert.equal(body.data.status, 'syncing');
    assert.equal(body.data.snapshot_status, 'pending');
    assert.equal(body.data.ledger_index, 0);
    assert.equal(body.data.token_count, 0);
    assert.equal(body.data.network_ledger_index, null);
    assert.ok(body.data.uptime_seconds >= 2);
    assert.equal(body.meta.ledger_index, 0);

    await app.close();
  });

  it('reports live after snapshot when the node is caught up', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    setIndexerState(db, 'snapshot_status', 'complete');
    setIndexerState(db, 'snapshot_ledger', '100');
    setIndexerState(db, 'live_from_ledger', '101');
    db.prepare(
      'INSERT INTO ledgers (ledger_index, close_time, hash, tx_count, indexed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(101, 1_700_000_000, 'A'.repeat(64), 0, 1_700_000_001);
    upsertIssuer(db, sampleIssuer());
    upsertToken(db, sampleToken());

    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ networkLedgerIndex: 102 }),
    });

    const response = await app.inject({ method: 'GET', url: '/v1/status' });
    const body = response.json() as { data: Status };
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.status, 'live');
    assert.equal(body.data.snapshot_status, 'complete');
    assert.equal(body.data.ledger_index, 101);
    assert.equal(body.data.lag_ledgers, 1);
    assert.equal(body.data.token_count, 1);
    assert.equal(body.data.issuer_count, 1);
    assert.equal(body.data.history_start_ledger, 101);
    assert.equal(body.data.backfill_status, 'idle');
    assert.equal(body.data.backfill_from, null);
    assert.equal(body.data.backfill_ledger, null);

    await app.close();
  });

  it('reports backfill progress and uses it as history_start_ledger', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    setIndexerState(db, 'snapshot_status', 'complete');
    setIndexerState(db, 'snapshot_ledger', '100');
    setIndexerState(db, 'live_from_ledger', '101');
    setIndexerState(db, 'backfill_status', 'running');
    setIndexerState(db, 'backfill_from', '40');
    setIndexerState(db, 'backfill_ledger', '55');
    db.prepare(
      'INSERT INTO ledgers (ledger_index, close_time, hash, tx_count, indexed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(100, 1_700_000_000, 'A'.repeat(64), 0, 1_700_000_001);

    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ networkLedgerIndex: 102 }),
    });
    const response = await app.inject({ method: 'GET', url: '/v1/status' });
    const body = response.json() as { data: Status };
    assert.equal(response.statusCode, 200);
    assert.equal(body.data.status, 'live');
    assert.equal(body.data.history_start_ledger, 40);
    assert.equal(body.data.backfill_status, 'running');
    assert.equal(body.data.backfill_from, 40);
    assert.equal(body.data.backfill_ledger, 55);
    await app.close();
  });

  it('returns a structured 404 for unknown routes', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime(),
    });
    const response = await app.inject({ method: 'GET', url: '/v1/nope' });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: { code: 'NOT_FOUND', message: 'No route GET /v1/nope' },
    });
    await app.close();
  });
});
