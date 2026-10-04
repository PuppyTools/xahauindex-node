import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { isDocsPath } from '../../src/api/rateLimit.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { testConfig, testRuntime } from '../helpers.js';

const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeDatabase(db);
  }
});

async function appWith(overrides: Parameters<typeof testConfig>[0] = {}) {
  const db = openDatabase(':memory:');
  dbs.push(db);
  const app = await buildApi({
    db,
    config: testConfig(overrides),
    runtime: testRuntime(),
  });
  return app;
}

describe('operator API rate limit', () => {
  it('treats the docs page and its assets as documentation paths', () => {
    assert.equal(isDocsPath('/'), true);
    assert.equal(isDocsPath('/docs'), true);
    assert.equal(isDocsPath('/docs/docs.css'), true);
    assert.equal(isDocsPath('/v1/openapi.yaml?download=1'), true);
    assert.equal(isDocsPath('/v1/status'), false);
    assert.equal(isDocsPath('/v1/tokens'), false);
  });

  it('stays unlimited when the max is unset', async () => {
    const app = await appWith();
    for (let i = 0; i < 5; i += 1) {
      const response = await app.inject({ method: 'GET', url: '/v1/status' });
      assert.equal(response.statusCode, 200);
    }
    await app.close();
  });

  it('returns the RATE_LIMITED envelope after the max', async () => {
    const app = await appWith({ apiRateLimitMax: 2, apiRateLimitWindowMs: 60_000 });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/status' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/status' })).statusCode, 200);
    const limited = await app.inject({ method: 'GET', url: '/v1/status' });
    assert.equal(limited.statusCode, 429);
    assert.deepEqual(limited.json(), {
      error: { code: 'RATE_LIMITED', message: 'Too many requests' },
    });
    assert.ok(limited.headers['retry-after']);
    await app.close();
  });

  it('does not count or block documentation routes', async () => {
    const app = await appWith({ apiRateLimitMax: 1, apiRateLimitWindowMs: 60_000 });
    assert.equal((await app.inject({ method: 'GET', url: '/docs' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/docs/docs.css' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/docs/cookbook.md' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/openapi.yaml' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/status' })).statusCode, 200);
    const limited = await app.inject({ method: 'GET', url: '/v1/tokens' });
    assert.equal(limited.statusCode, 429);
    assert.equal((await app.inject({ method: 'GET', url: '/docs' })).statusCode, 200);
    await app.close();
  });

  it('counts unknown routes toward the same bucket', async () => {
    const app = await appWith({ apiRateLimitMax: 1, apiRateLimitWindowMs: 60_000 });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/nope' })).statusCode, 404);
    const limited = await app.inject({ method: 'GET', url: '/v1/status' });
    assert.equal(limited.statusCode, 429);
    await app.close();
  });

  it('skips IPs on the allow list', async () => {
    const app = await appWith({
      apiRateLimitMax: 1,
      apiRateLimitWindowMs: 60_000,
      apiRateLimitAllow: ['127.0.0.1'],
    });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/status' })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/status' })).statusCode, 200);
    await app.close();
  });

  it('keys clients by X-Forwarded-For when trustProxy is on', async () => {
    const app = await appWith({
      apiRateLimitMax: 1,
      apiRateLimitWindowMs: 60_000,
      apiTrustProxy: true,
    });
    const first = await app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    const other = await app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { 'x-forwarded-for': '203.0.113.11' },
    });
    const again = await app.inject({
      method: 'GET',
      url: '/v1/status',
      headers: { 'x-forwarded-for': '203.0.113.10' },
    });
    assert.equal(first.statusCode, 200);
    assert.equal(other.statusCode, 200);
    assert.equal(again.statusCode, 429);
    await app.close();
  });
});
