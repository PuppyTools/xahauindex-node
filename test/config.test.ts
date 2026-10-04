import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  ConfigError,
  DEFAULT_API_RATE_LIMIT_WINDOW_MS,
  DEFAULT_WS_MAX_PER_IP,
  loadConfig,
  resolveBackfillFrom,
  resolveBackfillMinIntervalMs,
  resolveBackfillSourceUrl,
  resolveWsMaxPerIp,
  SHARED_BACKFILL_INTERVAL_MS,
} from '../src/config.js';

describe('loadConfig', () => {
  it('uses mainnet defaults', () => {
    const config = loadConfig({});
    assert.equal(config.xahaudUrl, 'wss://xahau.network');
    assert.equal(config.dbPath, './data/xahauindex.db');
    assert.equal(config.apiPort, 3000);
    assert.equal(config.apiHost, '0.0.0.0');
    assert.equal(config.logLevel, 'info');
    assert.equal(config.apiRateLimitMax, null);
    assert.equal(config.apiRateLimitWindowMs, DEFAULT_API_RATE_LIMIT_WINDOW_MS);
    assert.equal(config.apiTrustProxy, false);
    assert.deepEqual(config.apiRateLimitAllow, []);
    assert.equal(config.apiWsMaxPerIp, null);
    assert.equal(resolveWsMaxPerIp(config), null);
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

  it('reads a dedicated backfill node URL', () => {
    const ws = loadConfig({ BACKFILL_XAHAUD_URL: 'wss://history.example' });
    assert.equal(ws.backfillXahaudUrl, 'wss://history.example');
    assert.equal(resolveBackfillSourceUrl(ws), 'wss://history.example');
    const rpc = loadConfig({ BACKFILL_XAHAUD_URL: 'https://history.example:51234' });
    assert.equal(rpc.backfillXahaudUrl, 'https://history.example:51234');
    const fallback = loadConfig({});
    assert.equal(fallback.backfillXahaudUrl, null);
    assert.equal(resolveBackfillSourceUrl(fallback), 'wss://xahau.network');
    assert.equal(fallback.backfillMinIntervalMs, null);
    assert.equal(resolveBackfillMinIntervalMs(fallback, false), SHARED_BACKFILL_INTERVAL_MS);
    assert.equal(resolveBackfillMinIntervalMs(fallback, true), 0);
  });

  it('reads BACKFILL_MIN_INTERVAL_MS including zero', () => {
    const paced = loadConfig({ BACKFILL_MIN_INTERVAL_MS: '250' });
    assert.equal(paced.backfillMinIntervalMs, 250);
    assert.equal(resolveBackfillMinIntervalMs(paced, true), 250);
    const off = loadConfig({ BACKFILL_MIN_INTERVAL_MS: '0' });
    assert.equal(resolveBackfillMinIntervalMs(off, false), 0);
  });

  it('reads the backfill node from a second env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xahauindex-backfill-env-'));
    const file = join(dir, '.env.history');
    writeFileSync(file, 'XAHAUD_URL=wss://archive.example\n');
    const config = loadConfig({
      XAHAUD_URL: 'wss://live.example',
      BACKFILL_ENV: file,
    });
    assert.equal(config.xahaudUrl, 'wss://live.example');
    assert.equal(config.backfillXahaudUrl, 'wss://archive.example');
    assert.equal(config.backfillEnvPath, file);
    assert.equal(resolveBackfillSourceUrl(config), 'wss://archive.example');
  });

  it('lets BACKFILL_XAHAUD_URL win over the second env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xahauindex-backfill-env-'));
    const file = join(dir, '.env.history');
    writeFileSync(file, 'XAHAUD_URL=wss://archive.example\n');
    const config = loadConfig({
      BACKFILL_XAHAUD_URL: 'https://override.example',
      BACKFILL_ENV: file,
    });
    assert.equal(config.backfillXahaudUrl, 'https://override.example');
    assert.equal(config.backfillEnvPath, null);
  });

  it('rejects a missing BACKFILL_ENV file and a bad backfill URL', () => {
    assert.throws(() => loadConfig({ BACKFILL_ENV: '/tmp/xahauindex-missing.env' }), ConfigError);
    assert.throws(() => loadConfig({ BACKFILL_XAHAUD_URL: 'ftp://history.example' }), ConfigError);
  });

  it('treats API_RATE_LIMIT_MAX 0 or unset as off', () => {
    assert.equal(loadConfig({}).apiRateLimitMax, null);
    assert.equal(loadConfig({ API_RATE_LIMIT_MAX: '0' }).apiRateLimitMax, null);
    assert.equal(loadConfig({ API_RATE_LIMIT_MAX: '120' }).apiRateLimitMax, 120);
  });

  it('reads operator rate-limit knobs', () => {
    const config = loadConfig({
      API_RATE_LIMIT_MAX: '60',
      API_RATE_LIMIT_WINDOW_MS: '15000',
      API_TRUST_PROXY: 'true',
      API_RATE_LIMIT_ALLOW: '127.0.0.1, 10.0.0.0/8',
      API_WS_MAX_PER_IP: '4',
    });
    assert.equal(config.apiRateLimitMax, 60);
    assert.equal(config.apiRateLimitWindowMs, 15_000);
    assert.equal(config.apiTrustProxy, true);
    assert.deepEqual(config.apiRateLimitAllow, ['127.0.0.1', '10.0.0.0/8']);
    assert.equal(config.apiWsMaxPerIp, 4);
    assert.equal(resolveWsMaxPerIp(config), 4);
  });

  it('inherits the websocket cap when only the HTTP limiter is on', () => {
    const limited = loadConfig({ API_RATE_LIMIT_MAX: '30' });
    assert.equal(resolveWsMaxPerIp(limited), DEFAULT_WS_MAX_PER_IP);
    const explicitOff = loadConfig({
      API_RATE_LIMIT_MAX: '30',
      API_WS_MAX_PER_IP: '0',
    });
    assert.equal(resolveWsMaxPerIp(explicitOff), null);
    const wsOnly = loadConfig({ API_WS_MAX_PER_IP: '2' });
    assert.equal(wsOnly.apiRateLimitMax, null);
    assert.equal(resolveWsMaxPerIp(wsOnly), 2);
  });

  it('rejects invalid rate-limit env', () => {
    assert.throws(() => loadConfig({ API_RATE_LIMIT_MAX: '-1' }), ConfigError);
    assert.throws(() => loadConfig({ API_RATE_LIMIT_WINDOW_MS: '0' }), ConfigError);
    assert.throws(() => loadConfig({ API_TRUST_PROXY: 'maybe' }), ConfigError);
    assert.throws(() => loadConfig({ API_RATE_LIMIT_ALLOW: 'not-an-ip' }), ConfigError);
  });
});
