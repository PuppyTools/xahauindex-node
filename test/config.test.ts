import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, loadConfig, resolveBackfillFrom } from '../src/config.js';

describe('loadConfig', () => {
  it('uses mainnet defaults', () => {
    const config = loadConfig({});
    assert.equal(config.xahaudUrl, 'wss://xahau.network');
    assert.equal(config.dbPath, './data/xahauindex.db');
    assert.equal(config.apiPort, 3000);
    assert.equal(config.apiHost, '0.0.0.0');
    assert.equal(config.logLevel, 'info');
  });

  it('reads overrides from env', () => {
    const config = loadConfig({
      XAHAUD_URL: 'wss://example.invalid',
      DB_PATH: '/tmp/xahau.db',
      API_PORT: '4010',
      API_HOST: '127.0.0.1',
      LOG_LEVEL: 'debug',
    });
    assert.equal(config.xahaudUrl, 'wss://example.invalid');
    assert.equal(config.dbPath, '/tmp/xahau.db');
    assert.equal(config.apiPort, 4010);
    assert.equal(config.apiHost, '127.0.0.1');
    assert.equal(config.logLevel, 'debug');
  });

  it('rejects a non-websocket URL', () => {
    assert.throws(() => loadConfig({ XAHAUD_URL: 'https://xahau.network' }), ConfigError);
  });

  it('rejects an invalid port', () => {
    assert.throws(() => loadConfig({ API_PORT: '0' }), ConfigError);
  });

  it('rejects an invalid log level', () => {
    assert.throws(() => loadConfig({ LOG_LEVEL: 'verbose' }), ConfigError);
  });

  it('defaults backfill bounds to unset', () => {
    const config = loadConfig({});
    assert.equal(config.backfillFromLedger, null);
    assert.equal(config.backfillLookback, null);
    assert.equal(resolveBackfillFrom(config, 100), null);
  });

  it('reads genesis and the FULL_HISTORY_START alias', () => {
    assert.equal(loadConfig({ BACKFILL_FROM_LEDGER: 'genesis' }).backfillFromLedger, 1);
    assert.equal(loadConfig({ BACKFILL_FROM_LEDGER: 'start' }).backfillFromLedger, 1);
    assert.equal(loadConfig({ FULL_HISTORY_START: '40' }).backfillFromLedger, 40);
    assert.equal(loadConfig({ BACKFILL_LOOKBACK: '250' }).backfillLookback, 250);
  });

  it('lets BACKFILL_FROM_LEDGER win over LOOKBACK', () => {
    const config = loadConfig({
      BACKFILL_FROM_LEDGER: '50',
      BACKFILL_LOOKBACK: '10',
    });
    assert.equal(resolveBackfillFrom(config, 100), 50);
    assert.equal(resolveBackfillFrom(config, 40), 40);
  });

  it('computes lookback from the snapshot ledger', () => {
    const config = loadConfig({ BACKFILL_LOOKBACK: '10' });
    assert.equal(resolveBackfillFrom(config, 100), 91);
    assert.equal(resolveBackfillFrom(config, 5), 1);
  });

  it('rejects invalid backfill bounds', () => {
    assert.throws(() => loadConfig({ BACKFILL_FROM_LEDGER: '0' }), ConfigError);
    assert.throws(() => loadConfig({ BACKFILL_LOOKBACK: 'nope' }), ConfigError);
  });
});
