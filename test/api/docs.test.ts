import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { renderCookbookMarkdown, replaceCookbookSection } from '../../src/api/docsPage.js';
import {
  exampleValues,
  loadOpenApi,
  loadOpenApiYaml,
  operationsOf,
  parseOpenApi,
  resolveParameter,
  resolveResponse,
} from '../../src/api/openapi.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { testConfig, testRuntime } from '../helpers.js';

const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeDatabase(db);
  }
});

describe('API docs', () => {
  it('serves a page generated from OpenAPI, plus the contract and cookbook', async () => {
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
    assert.match(docs.body, /Not a stand-in for/);
    assert.match(docs.body, /raw ledgers, transactions, and books/);
    assert.match(docs.body, /"source": "onchain"/);
    assert.match(docs.body, /RATE_LIMITED/);
    assert.match(docs.body, /\/v1\/hooks\/definitions/);
    assert.match(docs.body, /Recipes/);
    assert.match(docs.body, /Cookbook/);
    assert.match(docs.body, /<details class="sample">/);
    assert.doesNotMatch(docs.body, /<details class="sample" open/);
    assert.doesNotMatch(docs.body, /Evernode governor/);
    assert.match(docs.body, /<button class="copy"/);
    assert.doesNotMatch(docs.body, /data-copy=/);
    assert.match(docs.body, /curl -s '?http:\/\/localhost:3000\/v1\/tokens/);
    assert.match(docs.body, /curl -s '?http:\/\/localhost:3000\/v1\/uritokens/);
    assert.match(docs.body, /curl -s '?http:\/\/localhost:3000\/v1\/prices/);
    assert.match(docs.body, /\/docs\/xi\.svg/);
    assert.match(docs.body, /rel="icon" href="\/docs\/favicon\.svg"/);
    assert.doesNotMatch(docs.body, /M24 3 43 14\.5/);

    const mark = await app.inject({ method: 'GET', url: '/docs/xi.svg' });
    assert.equal(mark.statusCode, 200);
    assert.match(mark.headers['content-type'] ?? '', /image\/svg\+xml/);
    assert.match(mark.body, /M44\.1611 62\.9598/);
    assert.doesNotMatch(mark.body, /445\.318/);

    const favicon = await app.inject({ method: 'GET', url: '/docs/favicon.svg' });
    assert.equal(favicon.statusCode, 200);
    assert.match(favicon.headers['content-type'] ?? '', /image\/svg\+xml/);
    assert.match(favicon.body, /M44\.1611 62\.9598/);
    assert.doesNotMatch(favicon.body, /445\.318/);
    assert.equal((await app.inject({ method: 'GET', url: '/favicon.svg' })).statusCode, 200);

    const css = await app.inject({ method: 'GET', url: '/docs/docs.css' });
    assert.equal(css.statusCode, 200);
    assert.match(css.headers['content-type'] ?? '', /text\/css/);

    const root = await app.inject({ method: 'GET', url: '/' });
    assert.equal(root.statusCode, 200);
    assert.match(root.body, /XahauIndex/);

    const spec = await app.inject({ method: 'GET', url: '/v1/openapi.yaml' });
    assert.equal(spec.statusCode, 200);
    assert.match(spec.body, /openapi: 3.1.0/);
    assert.match(spec.body, /title: XahauIndex API/);
    assert.match(spec.body, /HookLabel/);
    assert.match(spec.body, /x-cookbook:/);

    const cookbook = await app.inject({ method: 'GET', url: '/docs/cookbook.md' });
    assert.equal(cookbook.statusCode, 200);
    assert.match(cookbook.body, /curl -s http:\/\/localhost:3000\/v1\/status/);

    await app.close();
  });

  it('requires a response example on every path', () => {
    const spec = loadOpenApi();
    for (const { path, method, operation } of operationsOf(spec)) {
      const ok = operation.responses?.['200'] ?? operation.responses?.['101'];
      assert.ok(ok, `${method.toUpperCase()} ${path} is missing a 200/101 response`);
      const resolved = resolveResponse(spec, ok);
      const media = resolved.content?.['application/json'];
      const values = exampleValues(spec, media);
      const messages = operation['x-messages'] ?? [];
      assert.ok(
        values.length > 0 || messages.length > 0,
        `${method.toUpperCase()} ${path} needs a JSON example or x-messages`,
      );
    }
  });

  it('describes every path parameter', () => {
    const spec = loadOpenApi();
    for (const { path, method, operation } of operationsOf(spec)) {
      for (const raw of operation.parameters ?? []) {
        const parameter = resolveParameter(spec, raw);
        const description = parameter.description ?? parameter.schema?.description ?? '';
        assert.notEqual(
          description.trim(),
          '',
          `${method.toUpperCase()} ${path} ${parameter.name ?? '?'} needs a description`,
        );
      }
    }
  });

  it('keeps cookbook.md and README in sync with OpenAPI', () => {
    const spec = parseOpenApi(loadOpenApiYaml());
    const cookbook = renderCookbookMarkdown(spec);
    assert.equal(readFileSync('docs/cookbook.md', 'utf8'), cookbook);
    const readme = readFileSync('README.md', 'utf8');
    assert.equal(
      readme,
      replaceCookbookSection(readme, renderCookbookMarkdown(spec, { standalone: false })),
    );
    assert.match(readme, /curl -s '?http:\/\/localhost:3000\/v1\/tokens/);
    assert.match(readme, /curl -s '?http:\/\/localhost:3000\/v1\/prices/);
  });
});
