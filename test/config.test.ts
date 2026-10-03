import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, loadConfig } from '../src/config.js';

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
});
