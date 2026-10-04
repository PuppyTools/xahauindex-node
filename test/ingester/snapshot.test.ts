import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { getIndexerState } from '../../src/db/queries/indexer.js';
import { getToken } from '../../src/db/queries/tokens.js';
import { getUriToken } from '../../src/db/queries/uritokens.js';
import { interpretRippleState } from '../../src/ingester/objects.js';
import { runSnapshot } from '../../src/ingester/snapshot.js';
import type { LedgerSource } from '../../src/ingester/source.js';
import type { RippleStateObject } from '../../src/types/xahau.js';
import { silentLog, testConfig, testRuntime } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const URI_ID = 'A'.repeat(64);
const HOOK_HASH = 'B'.repeat(64);

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

const rippleState = {
  LedgerEntryType: 'RippleState',
  index: 'C'.repeat(64),
  Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '-25' },
  LowLimit: { currency: 'USD', issuer: ISSUER, value: '0' },
  HighLimit: { currency: 'USD', issuer: HOLDER, value: '100' },
  Flags: 0,
  Remarks: [
    {
      Remark: {
        RemarkName: Buffer.from('name').toString('hex'),
        RemarkValue: Buffer.from('USD stable').toString('hex'),
      },
    },
  ],
};

const issuerRoot = {
  LedgerEntryType: 'AccountRoot',
  index: 'D'.repeat(64),
  Account: ISSUER,
  Flags: 0,
  Domain: Buffer.from('example.com').toString('hex'),
  Hook: [{ Hook: { HookHash: HOOK_HASH, HookOn: '0' } }],
  Remarks: [
    {
      Remark: {
        RemarkName: Buffer.from('website').toString('hex'),
        RemarkValue: Buffer.from('https://example.com').toString('hex'),
      },
    },
  ],
};

const uriToken = {
  LedgerEntryType: 'URIToken',
  index: URI_ID,
  URI: Buffer.from('https://nft.example/1').toString('hex'),
  Issuer: ISSUER,
  Owner: HOLDER,
  Digest: 'E'.repeat(64),
  Amount: '1000000',
  Remarks: [
    {
      Remark: {
        RemarkName: Buffer.from('name').toString('hex'),
        RemarkValue: Buffer.from('Cool NFT').toString('hex'),
      },
    },
  ],
};

function pagesSource(pages: unknown[][], ledger = 50): LedgerSource {
  return {
    getValidatedLedger: async () => ({
      index: ledger,
      hash: 'F'.repeat(64),
      closeTime: 1_700_000_000,
    }),
    getLedgerDataPage: async (_index, marker) => {
      const index = typeof marker === 'number' ? marker : 0;
      const state = pages[index] ?? [];
      const next = index + 1;
      if (next < pages.length) {
        return { state, marker: next };
      }
      return { state };
    },
  };
}

describe('interpretRippleState', () => {
  it('treats the zero-limit side as the issuer', () => {
    const view = interpretRippleState(rippleState as RippleStateObject);
    assert.ok(view);
    assert.equal(view.issuer, ISSUER);
    assert.equal(view.holder, HOLDER);
    assert.equal(view.balance, '25');
    assert.equal(view.currency, 'USD');
  });

  it('canonicalizes scientific-notation balances', () => {
    const view = interpretRippleState({
      ...rippleState,
      Balance: {
        currency: 'USD',
        issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji',
        value: '-5296754300000000e-26',
      },
    } as RippleStateObject);
    assert.ok(view);
    assert.equal(view.issuer, ISSUER);
    assert.equal(view.holder, HOLDER);
    assert.equal(view.balance, '0.000000000052967543');
  });
});

describe('runSnapshot', () => {
  it('indexes tokens, URITokens, hooks, and remarks from ledger_data pages', async () => {
    const db = memoryDb();
    const result = await runSnapshot({
      db,
      source: pagesSource([[rippleState], [issuerRoot, uriToken]]),
      log: silentLog,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.ledger, 50);
    assert.equal(result.pages, 2);

    const token = getToken(db, `USD:${ISSUER}`);
    assert.ok(token);
    assert.equal(token.holder_count, 1);
    assert.equal(token.trust_count, 1);
    assert.equal(token.supply, '25');
    assert.equal(token.name, 'USD stable');

    const nft = getUriToken(db, URI_ID);
    assert.ok(nft);
    assert.equal(nft.uri, 'https://nft.example/1');
    assert.equal(nft.owner, HOLDER);
    assert.equal(nft.sell_offer, '1000000');

    assert.equal(getIndexerState(db, 'snapshot_status'), 'complete');
    assert.equal(getIndexerState(db, 'live_from_ledger'), '51');

    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ networkLedgerIndex: 50 }),
    });
    const status = await app.inject({ method: 'GET', url: '/v1/status' });
    const tokens = await app.inject({ method: 'GET', url: '/v1/tokens' });
    const nftRes = await app.inject({ method: 'GET', url: `/v1/uritokens/${URI_ID}` });
    const issuerRes = await app.inject({ method: 'GET', url: `/v1/issuers/${ISSUER}` });
    assert.equal(status.json().data.status, 'live');
    assert.equal(status.json().data.token_count, 1);
    assert.equal(status.json().data.uri_token_count, 1);
    assert.equal(tokens.json().data[0].currency, 'USD');
    assert.equal(nftRes.json().data.remarks.name, 'Cool NFT');
    assert.equal(issuerRes.json().data.domain, 'example.com');
    assert.equal(issuerRes.json().data.has_hooks, true);
    await app.close();
  });

  it('resumes from a persisted marker after a failed page', async () => {
    const db = memoryDb();
    let calls = 0;
    const flaky: LedgerSource = {
      getValidatedLedger: async () => ({
        index: 9,
        hash: '1'.repeat(64),
        closeTime: 1_700_000_100,
      }),
      getLedgerDataPage: async (_index, marker) => {
        calls += 1;
        if (marker === undefined) {
          return { state: [rippleState], marker: 1 };
        }
        if (calls === 2) {
          throw new Error('ws drop');
        }
        return { state: [uriToken] };
      },
    };

    await assert.rejects(
      () => runSnapshot({ db, source: flaky, log: silentLog, pageAttempts: 1 }),
      /ws drop/,
    );
    assert.equal(getIndexerState(db, 'snapshot_status'), 'running');
    assert.ok(getToken(db, `USD:${ISSUER}`));

    const result = await runSnapshot({ db, source: flaky, log: silentLog });
    assert.equal(result.skipped, false);
    assert.ok(getUriToken(db, URI_ID));
    assert.equal(getIndexerState(db, 'snapshot_status'), 'complete');
  });
});
