import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { testConfig, testRuntime } from '../helpers.js';

const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeDatabase(db);
  }
});

describe('API docs', () => {
  it('serves the branded docs page and OpenAPI contract', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime(),
    });

    const docs = await app.inject({ method: 'GET', url: '/docs' });
    assert.equal(docs.statusCode, 200);
    assert.match(docs.headers['content-type'] ?? '', /text\/html/);
    assert.match(docs.body, /XahauIndex/);
    assert.match(docs.body, /\/v1\/tokens\/\{currency\}\/\{issuer\}/);
    assert.match(docs.body, /\/v1\/subscribe/);
    assert.match(docs.body, /source: "onchain"/);
    assert.match(docs.body, /RATE_LIMITED/);
    assert.match(docs.body, /\/v1\/hooks\/definitions/);

    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 200);
    assert.match(root.body, /XahauIndex/);

    const spec = await app.inject({ method: 'GET', url: '/v1/openapi.yaml' });
    assert.equal(spec.statusCode, 200);
    assert.match(spec.body, /openapi: 3.1.0/);
    assert.match(spec.body, /title: XahauIndex API/);

    await app.close();
  });
});
