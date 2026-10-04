import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { getIssuer, listIssuersDueForToml, upsertIssuer } from '../../src/db/queries/issuers.js';
import { getToken, upsertToken } from '../../src/db/queries/tokens.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import { requeueUnverifiedTokenIssuers, runTomlPass, verifyIssuerToml } from '../../src/ingester/toml.js';
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

[[WEBLINKS]]
url = "https://example.com"
type = "website"
title = "Site"

[[WEBLINKS]]
url = "https://x.com/example"
type = "socialmedia"
title = "X"
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
    assert.equal(
      verified.toml_links,
      JSON.stringify([
        { url: 'https://example.com', type: 'website', title: 'Site' },
        { url: 'https://x.com/example', type: 'social', title: 'X' },
      ]),
    );
    const token = getToken(db, `USD:${ISSUER}`);
    assert.equal(token?.domain_verified, 1);
    assert.equal(token?.icon_url, 'https://example.com/icon.png');
    assert.equal(token?.website_url, 'https://example.com');
    assert.equal(token?.toml_links, verified.toml_links);

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

  it('verifies issuers listed only under ISSUERS', async () => {
    const db = memoryDb();
    upsertIssuer(db, sampleIssuer());
    const ok = await verifyIssuerToml({
      db,
      account: ISSUER,
      ledger: 80,
      log: silentLog,
      loader: async () => `
[[ISSUERS]]
address = "${ISSUER}"
name = "Xspence"
`,
    });
    assert.equal(ok.verified, true);
    assert.equal(getIssuer(db, ISSUER)?.toml_name, 'Xspence');
  });

  it('checks token issuers before host-only domains and requeues after a logic bump', async () => {
    const db = memoryDb();
    const host = 'r44E6yrTudryFYeZ62JP2GZTwcXvDhJg6E';
    upsertIssuer(db, { ...sampleIssuer(host), domain: 'node.evernode.example', toml_checked_ledger: 10 });
    upsertIssuer(db, { ...sampleIssuer(), toml_checked_ledger: 10 });
    upsertToken(db, sampleToken());

    const dueBefore = listIssuersDueForToml(db, 10, 1000);
    assert.equal(dueBefore.length, 0);

    const requeued = requeueUnverifiedTokenIssuers(db);
    assert.equal(requeued, 1);
    assert.equal(requeueUnverifiedTokenIssuers(db), 0);

    const due = listIssuersDueForToml(db, 20, 1000);
    assert.equal(due[0]?.account, ISSUER);
    assert.equal(due.length, 1);

    upsertIssuer(db, { ...sampleIssuer(host), domain: 'node.evernode.example', toml_checked_ledger: null });
    const ordered = listIssuersDueForToml(db, 20, 1000);
    assert.equal(ordered[0]?.account, ISSUER);
    assert.equal(ordered[1]?.account, host);
  });

  it('skips hex blobs without calling the loader', async () => {
    const db = memoryDb();
    upsertIssuer(db, {
      ...sampleIssuer(),
      domain: 'ED7573749189112BED42DED36ECFE7BFF43C2D50A6A3F080EF874BE3D5CCDC2B004D59584A000000000000',
    });
    let loads = 0;
    const result = await verifyIssuerToml({
      db,
      account: ISSUER,
      ledger: 50,
      log: silentLog,
      loader: async () => {
        loads += 1;
        return listedToml();
      },
    });
    assert.equal(result.verified, false);
    assert.equal(result.error, 'invalid domain');
    assert.equal(loads, 0);
    assert.equal(getIssuer(db, ISSUER)?.toml_checked_ledger, 50);
    assert.equal(getIssuer(db, ISSUER)?.domain_verified, 0);
  });
});
