import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { getIssuer, listIssuersDueForToml, upsertIssuer } from '../../src/db/queries/issuers.js';
import { getToken, upsertToken } from '../../src/db/queries/tokens.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import { runTomlPass, verifyIssuerToml } from '../../src/ingester/toml.js';
import { silentLog, sampleIssuer, sampleToken } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

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

function listedToml(account = ISSUER): string {
  return `
[METADATA]
name = "Example"
desc = "A test issuer"
icon = "https://example.com/icon.png"

[[ACCOUNTS]]
address = "${account}"
name = "Treasury"
`;
}

describe('TOML verification', () => {
  it('flips domain_verified on success and failure fixtures', async () => {
    const db = memoryDb();
    upsertIssuer(db, sampleIssuer());
    upsertToken(db, sampleToken());

    const ok = await verifyIssuerToml({
      db,
      account: ISSUER,
      ledger: 100,
      log: silentLog,
      loader: async () => listedToml(),
    });
    assert.equal(ok.verified, true);
    const verified = getIssuer(db, ISSUER);
    assert.ok(verified);
    assert.equal(verified.domain_verified, 1);
    assert.equal(verified.toml_name, 'Treasury');
    assert.equal(verified.toml_icon_url, 'https://example.com/icon.png');
    assert.equal(verified.toml_checked_ledger, 100);
    assert.equal(getToken(db, `USD:${ISSUER}`)?.domain_verified, 1);

    const missing = await verifyIssuerToml({
      db,
      account: ISSUER,
      ledger: 1100,
      log: silentLog,
      loader: async () => '[METADATA]\nname = "Nope"\n',
    });
    assert.equal(missing.verified, false);
    assert.equal(getIssuer(db, ISSUER)?.domain_verified, 0);
    assert.equal(getToken(db, `USD:${ISSUER}`)?.domain_verified, 0);

    const failed = await verifyIssuerToml({
      db,
      account: ISSUER,
      ledger: 2100,
      log: silentLog,
      loader: async () => {
        throw new Error('TOML HTTP 404');
      },
    });
    assert.equal(failed.verified, false);
    assert.equal(failed.error, 'TOML HTTP 404');
    assert.equal(getIssuer(db, ISSUER)?.domain_verified, 0);
    assert.equal(getIssuer(db, ISSUER)?.toml_checked_ledger, 2100);
  });

  it('re-queues after 1000 ledgers and on Domain change', async () => {
    const db = memoryDb();
    upsertIssuer(db, sampleIssuer());
    await verifyIssuerToml({
      db,
      account: ISSUER,
      ledger: 100,
      log: silentLog,
      loader: async () => listedToml(),
    });
    assert.equal(listIssuersDueForToml(db, 1099).length, 0);
    assert.equal(listIssuersDueForToml(db, 1100).length, 1);

    const pass = await runTomlPass({
      db,
      ledger: 1100,
      log: silentLog,
      loader: async () => listedToml(),
    });
    assert.equal(pass[0]?.verified, true);
    assert.equal(listIssuersDueForToml(db, 1100).length, 0);

    applyClosedLedger(
      db,
      {
        index: 1200,
        hash: 'a'.repeat(64),
        closeTime: 1_700_000_000,
        transactions: [
          {
            hash: 'b'.repeat(64),
            TransactionType: 'AccountSet',
            Account: ISSUER,
            meta: {
              TransactionResult: 'tesSUCCESS',
              AffectedNodes: [
                {
                  ModifiedNode: {
                    LedgerEntryType: 'AccountRoot',
                    LedgerIndex: 'c'.repeat(64),
                    FinalFields: {
                      Account: ISSUER,
                      Domain: Buffer.from('other.example').toString('hex'),
                      Flags: 0,
                    },
                    PreviousFields: {
                      Domain: Buffer.from('example.com').toString('hex'),
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
    const afterDomain = getIssuer(db, ISSUER);
    assert.ok(afterDomain);
    assert.equal(afterDomain.domain, 'other.example');
    assert.equal(afterDomain.domain_verified, 0);
    assert.equal(afterDomain.toml_checked_ledger, null);
    assert.equal(listIssuersDueForToml(db, 1200).length, 1);
  });
});
