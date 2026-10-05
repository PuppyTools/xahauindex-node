import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { upsertOhlcvCandle } from '../../src/db/queries/dex.js';
import { setIndexerState, getIndexerState } from '../../src/db/queries/indexer.js';
import { upsertIssuer } from '../../src/db/queries/issuers.js';
import { listRemarksByObject, upsertRemark, remarksToMap } from '../../src/db/queries/remarks.js';
import { getToken, recomputeTokenAggregates, upsertToken, upsertTrustLine } from '../../src/db/queries/tokens.js';
import { sampleIssuer, sampleToken } from '../helpers.js';

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

describe('openDatabase', () => {
  it('applies 001_init and exposes core tables', () => {
    const db = memoryDb();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name);
    for (const required of [
      'indexer_state',
      'ledgers',
      'tokens',
      'issuers',
      'uri_tokens',
      'remarks',
      'hook_accounts',
      'hook_definitions',
      'dex_trades',
      'ohlcv_candles',
      'schema_migrations',
    ]) {
      assert.ok(names.includes(required), `missing table ${required}`);
    }

    const applied = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
    assert.deepEqual(
      applied.map((row) => row.id),
      [
        '001_init.sql',
        '002_issuer_toml.sql',
        '003_backfill.sql',
        '004_icon_urls.sql',
        '005_uri_metadata.sql',
        '006_toml_links.sql',
        '007_hook_definitions.sql',
        '008_dex_trade_sides.sql',
      ],
    );
  });

  it('upserts issuer then token and reads it back', () => {
    const db = memoryDb();
    const issuer = sampleIssuer();
    const token = sampleToken();
    upsertIssuer(db, issuer);
    upsertToken(db, token);
    const found = getToken(db, token.id);
    assert.ok(found);
    assert.equal(found.currency, 'USD');
    assert.equal(found.issuer, issuer.account);
    assert.equal(found.holder_count, 1);
  });

  it('stores remarks as a name/value map', () => {
    const db = memoryDb();
    upsertRemark(db, {
      object_id: 'A'.repeat(64),
      object_type: 'URIToken',
      name: 'name',
      value: 'Cool NFT',
      immutable: 0,
      uri_token_id: 'A'.repeat(64),
      account: null,
      token_id: null,
      last_updated: 10,
    });
    const map = remarksToMap(listRemarksByObject(db, 'A'.repeat(64)));
    assert.equal(map.name, 'Cool NFT');
  });

  it('treats null XAH issuers as one OHLCV pair', () => {
    const db = memoryDb();
    const candle = {
      base_currency: 'USD',
      base_issuer: 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh',
      counter_currency: 'XAH',
      counter_issuer: null,
      period: '1h' as const,
      open_time: 1_700_000_000,
      open_ledger: 10,
      close_ledger: 11,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: '10',
      trade_count: 1,
    };
    upsertOhlcvCandle(db, candle);
    upsertOhlcvCandle(db, { ...candle, close: 1.75, trade_count: 2, volume: '12' });
    const rows = db.prepare('SELECT * FROM ohlcv_candles').all() as Array<{
      close: number;
      trade_count: number;
    }>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.close, 1.75);
    assert.equal(rows[0]?.trade_count, 2);
  });

  it('sums scientific-notation trust-line balances into supply', () => {
    const db = memoryDb();
    const issuer = sampleIssuer();
    const token = sampleToken();
    upsertIssuer(db, issuer);
    upsertToken(db, token);
    upsertTrustLine(db, {
      id: `rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe:${token.currency}:${issuer.account}`,
      account: 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe',
      currency: token.currency,
      issuer: issuer.account,
      balance: '5296754300000000e-26',
      limit_peer: '100',
      quality_in: null,
      quality_out: null,
      flags: 0,
      first_ledger: 1,
      last_updated: 1,
    });
    recomputeTokenAggregates(db);
    const found = getToken(db, token.id);
    assert.ok(found);
    assert.equal(found.supply, '0.000000000052967543');
    assert.equal(found.holder_count, 1);
    assert.equal(found.trust_count, 1);
  });

  it('persists indexer_state keys for snapshot resume', () => {
    const db = memoryDb();
    setIndexerState(db, 'snapshot_status', 'running');
    setIndexerState(db, 'snapshot_ledger', '42');
    assert.equal(getIndexerState(db, 'snapshot_status'), 'running');
    assert.equal(getIndexerState(db, 'snapshot_ledger'), '42');
  });
});
