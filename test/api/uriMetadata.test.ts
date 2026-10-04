import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { upsertUriToken } from '../../src/db/queries/uritokens.js';
import { testConfig, testRuntime } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const URI_ID = 'C'.repeat(64);
const LEASE_URI = 'ZXZybGVhc2VMVFYAAQAACAFnfryy9275fVMVSdiyfVQDjX6kxoAAMPnVSwAAAAAAAAAAAAAAAAAAAAAA';

const dbs: SqliteDatabase[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeDatabase(db);
  }
});

describe('URIToken on-chain metadata', () => {
  it('serves a decoded Evernode lease on GET /v1/uritokens/:id', async () => {
    const db = openDatabase(':memory:');
    dbs.push(db);
    upsertUriToken(db, {
      id: URI_ID,
      uri: LEASE_URI,
      uri_raw: Buffer.from(LEASE_URI).toString('hex'),
      digest: null,
      issuer: ISSUER,
      owner: ISSUER,
      flags: 1,
      sell_offer: null,
      destination: null,
      burned: 0,
      burn_ledger: null,
      mint_ledger: 10,
      last_updated: 10,
      icon_url: null,
      uri_metadata: null,
      uri_meta_checked_ledger: null,
    });
    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime(),
    });
    const response = await app.inject({ method: 'GET', url: `/v1/uritokens/${URI_ID}` });
    assert.equal(response.statusCode, 200);
    const body = response.json() as {
      data: {
        uri_kind: string;
        metadata: { source: string; format: string; lease_index: number; name: string };
      };
    };
    assert.equal(body.data.uri_kind, 'onchain');
    assert.equal(body.data.metadata.source, 'onchain');
    assert.equal(body.data.metadata.format, 'evrlease');
    assert.equal(body.data.metadata.lease_index, 0);
    assert.equal(body.data.metadata.name, 'Evernode lease #0');
    await app.close();
  });
});
