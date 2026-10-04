import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { getIssuer } from '../../src/db/queries/issuers.js';
import { getToken, upsertToken } from '../../src/db/queries/tokens.js';
import { ensureIssuer } from '../../src/db/queries/issuers.js';
import { normalizeHookEntries } from '../../src/ingester/hooks.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import { LSF_DISABLE_MASTER } from '../../src/util/xahau.js';
import { silentLog, sampleToken, testConfig, testRuntime } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const FIRST_HOOK = 'B'.repeat(64);
const SECOND_HOOK = 'C'.repeat(64);

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

function hookTx(index: number, hash: string, hooks: Array<Record<string, unknown>>) {
  return {
    hash,
    TransactionType: 'SetHook',
    Account: ISSUER,
    meta: {
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [
        {
          ModifiedNode: {
            LedgerEntryType: 'Hook',
            LedgerIndex: 'd'.repeat(64),
            FinalFields: {
              Account: ISSUER,
              Flags: 0,
              Hooks: hooks,
            },
          },
        },
      ],
    },
  };
}

describe('normalizeHookEntries', () => {
  it('keeps nested and flat hashes and drops empty slots', () => {
    const hooks = normalizeHookEntries([
      { Hook: { HookHash: FIRST_HOOK, HookOnIncoming: '1' } },
      { Hook: {} },
      { HookHash: SECOND_HOOK, HookNamespace: '0'.repeat(64) },
    ]);
    assert.equal(hooks.length, 2);
    assert.equal(hooks[0]?.hook_hash, FIRST_HOOK);
    assert.equal(hooks[0]?.hook_on_incoming, '1');
    assert.equal(hooks[1]?.hook_hash, SECOND_HOOK);
    assert.equal(hooks[1]?.hook_namespace, '0'.repeat(64));
  });
});

describe('SetHook and blackhole', () => {
  it('replaces the hook array and filters by hook_hash', async () => {
    const db = memoryDb();
    applyClosedLedger(
      db,
      {
        index: 51,
        hash: '1'.repeat(64),
        closeTime: 1_700_000_051,
        transactions: [
          hookTx(51, '11'.repeat(32), [{ Hook: { HookHash: FIRST_HOOK, HookOn: '0' } }]),
        ],
      },
      silentLog,
    );
    applyClosedLedger(
      db,
      {
        index: 52,
        hash: '2'.repeat(64),
        closeTime: 1_700_000_052,
        transactions: [
          hookTx(52, '12'.repeat(32), [
            { Hook: { HookHash: SECOND_HOOK, HookOnIncoming: '1', HookOnOutgoing: '2' } },
          ]),
        ],
      },
      silentLog,
    );

    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ networkLedgerIndex: 52 }),
    });
    const listed = await app.inject({ method: 'GET', url: '/v1/hooks' });
    const first = await app.inject({ method: 'GET', url: `/v1/hooks?hook_hash=${FIRST_HOOK}` });
    const second = await app.inject({ method: 'GET', url: `/v1/hooks?hook_hash=${SECOND_HOOK}` });
    const account = await app.inject({ method: 'GET', url: `/v1/hooks/${ISSUER}` });
    assert.equal(listed.json().data.length, 1);
    assert.equal(first.json().data.length, 0);
    assert.equal(second.json().data.length, 1);
    assert.equal(account.json().data.hook_count, 1);
    assert.equal(account.json().data.hooks[0].hook_hash, SECOND_HOOK);
    assert.equal(account.json().data.hooks[0].hook_on_incoming, '1');
    await app.close();
  });

  it('ignores empty Hook slots and removes the row when the Hook object is deleted', async () => {
    const db = memoryDb();
    applyClosedLedger(
      db,
      {
        index: 51,
        hash: '4'.repeat(64),
        closeTime: 1_700_000_051,
        transactions: [
          hookTx(51, '14'.repeat(32), [
            { Hook: { HookHash: FIRST_HOOK, HookNamespace: '0'.repeat(64) } },
            { Hook: {} },
            { Hook: {} },
            { Hook: {} },
          ]),
        ],
      },
      silentLog,
    );
    applyClosedLedger(
      db,
      {
        index: 52,
        hash: '5'.repeat(64),
        closeTime: 1_700_000_052,
        transactions: [
          {
            hash: '15'.repeat(32),
            TransactionType: 'SetHook',
            Account: ISSUER,
            meta: {
              TransactionResult: 'tesSUCCESS',
              AffectedNodes: [
                {
                  DeletedNode: {
                    LedgerEntryType: 'Hook',
                    LedgerIndex: 'd'.repeat(64),
                    FinalFields: {
                      Account: ISSUER,
                      Hooks: [{ Hook: { HookHash: FIRST_HOOK } }],
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      silentLog,
    );

    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ networkLedgerIndex: 52 }),
    });
    const listed = await app.inject({ method: 'GET', url: '/v1/hooks' });
    const account = await app.inject({ method: 'GET', url: `/v1/hooks/${ISSUER}` });
    const issuer = await app.inject({ method: 'GET', url: `/v1/issuers/${ISSUER}` });
    assert.equal(listed.json().data.length, 0);
    assert.equal(account.statusCode, 404);
    assert.equal(issuer.json().data.has_hooks, false);
    await app.close();
  });

  it('marks a blackholed issuer and copies the flag onto tokens', () => {
    const db = memoryDb();
    ensureIssuer(db, ISSUER, 1);
    upsertToken(db, sampleToken());
    applyClosedLedger(
      db,
      {
        index: 51,
        hash: '3'.repeat(64),
        closeTime: 1_700_000_051,
        transactions: [
          {
            hash: '13'.repeat(32),
            TransactionType: 'AccountSet',
            Account: ISSUER,
            meta: {
              TransactionResult: 'tesSUCCESS',
              AffectedNodes: [
                {
                  ModifiedNode: {
                    LedgerEntryType: 'AccountRoot',
                    LedgerIndex: 'e'.repeat(64),
                    FinalFields: {
                      Account: ISSUER,
                      Flags: LSF_DISABLE_MASTER,
                    },
                  },
                },
              ],
            },
          },
        ],
      },
      silentLog,
    );
    assert.equal(getIssuer(db, ISSUER)?.blackholed, 1);
    assert.equal(getToken(db, `USD:${ISSUER}`)?.blackholed, 1);
  });
});
