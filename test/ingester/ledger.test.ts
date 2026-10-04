import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { setIndexerState } from '../../src/db/queries/indexer.js';
import { getToken, getTrustLine } from '../../src/db/queries/tokens.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import type { ClosedLedger } from '../../src/ingester/source.js';
import { silentLog, testConfig, testRuntime } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const RIPPLE_INDEX = 'C'.repeat(64);

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

function closedLedger(index: number, transactions: unknown[]): ClosedLedger {
  return {
    index,
    hash: index.toString(16).padStart(64, '0'),
    closeTime: 1_700_000_000 + index,
    transactions,
  };
}

function rippleFields(balance: string, remarks?: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: balance },
    LowLimit: { currency: 'USD', issuer: ISSUER, value: '0' },
    HighLimit: { currency: 'USD', issuer: HOLDER, value: '100' },
    Flags: 0,
  };
  if (remarks !== undefined) {
    fields.Remarks = remarks;
  }
  return fields;
}

describe('applyClosedLedger tokens', () => {
  it('applies TrustSet then Payment exactly once', async () => {
    const db = memoryDb();
    setIndexerState(db, 'snapshot_status', 'complete');
    setIndexerState(db, 'snapshot_ledger', '50');
    setIndexerState(db, 'live_from_ledger', '51');

    const trustSet = {
      hash: '1'.repeat(64),
      TransactionType: 'TrustSet',
      Account: HOLDER,
      meta: {
        TransactionResult: 'tesSUCCESS',
        AffectedNodes: [
          {
            CreatedNode: {
              LedgerEntryType: 'RippleState',
              LedgerIndex: RIPPLE_INDEX,
              NewFields: rippleFields('0'),
            },
          },
        ],
      },
    };
    const failed = {
      hash: '2'.repeat(64),
      TransactionType: 'Payment',
      Account: ISSUER,
      meta: { TransactionResult: 'tecPATH_DRY', AffectedNodes: [] },
    };
    const payment = {
      hash: '3'.repeat(64),
      TransactionType: 'Payment',
      Account: ISSUER,
      meta: {
        TransactionResult: 'tesSUCCESS',
        AffectedNodes: [
          {
            ModifiedNode: {
              LedgerEntryType: 'RippleState',
              LedgerIndex: RIPPLE_INDEX,
              FinalFields: rippleFields('-25'),
              PreviousFields: { Balance: { currency: 'USD', issuer: 'rrrrrrrrrrrrrrrrrrrrBZbvji', value: '0' } },
            },
          },
        ],
      },
    };

    const first = applyClosedLedger(db, closedLedger(51, [trustSet, failed]), silentLog);
    assert.equal(first.applied, true);
    assert.equal(first.txApplied, 1);
    const afterTrust = getToken(db, `USD:${ISSUER}`);
    assert.ok(afterTrust);
    assert.equal(afterTrust.trust_count, 1);
    assert.equal(afterTrust.holder_count, 0);
    assert.equal(afterTrust.supply, '0');

    const second = applyClosedLedger(db, closedLedger(52, [payment]), silentLog);
    assert.equal(second.applied, true);
    const token = getToken(db, `USD:${ISSUER}`);
    assert.ok(token);
    assert.equal(token.holder_count, 1);
    assert.equal(token.trust_count, 1);
    assert.equal(token.supply, '25');
    assert.equal(getTrustLine(db, `${HOLDER}:USD:${ISSUER}`)?.balance, '25');

    const replay = applyClosedLedger(db, closedLedger(52, [payment]), silentLog);
    assert.equal(replay.skipped, true);
    assert.equal(replay.reason, 'already_indexed');
    const replayed = getToken(db, `USD:${ISSUER}`);
    assert.ok(replayed);
    assert.equal(replayed.supply, '25');
    assert.equal(replayed.holder_count, 1);

    const beforeSnapshot = applyClosedLedger(db, closedLedger(50, [payment]), silentLog);
    assert.equal(beforeSnapshot.reason, 'at_or_before_snapshot');

    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ networkLedgerIndex: 52 }),
    });
    const tokenRes = await app.inject({ method: 'GET', url: `/v1/tokens/USD/${ISSUER}` });
    assert.equal(tokenRes.statusCode, 200);
    assert.equal(tokenRes.json().data.supply, '25');
    assert.equal(tokenRes.json().data.holder_count, 1);
    await app.close();

    const cleared = applyClosedLedger(
      db,
      closedLedger(53, [
        {
          hash: '4'.repeat(64),
          TransactionType: 'TrustSet',
          Account: HOLDER,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                DeletedNode: {
                  LedgerEntryType: 'RippleState',
                  LedgerIndex: RIPPLE_INDEX,
                  FinalFields: rippleFields('-25'),
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );
    assert.equal(cleared.applied, true);
    assert.equal(getTrustLine(db, `${HOLDER}:USD:${ISSUER}`), undefined);
    const afterDelete = getToken(db, `USD:${ISSUER}`);
    assert.ok(afterDelete);
    assert.equal(afterDelete.holder_count, 0);
    assert.equal(afterDelete.trust_count, 0);
    assert.equal(afterDelete.supply, '0');
  });
});
