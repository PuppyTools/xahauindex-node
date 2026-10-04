import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { getUriToken, upsertUriToken } from '../../src/db/queries/uritokens.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import { refreshUriTokenMetadata, runUriMetaPass } from '../../src/ingester/metadata.js';
import { silentLog } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const URI_ID = 'A'.repeat(64);
const META_ID = 'B'.repeat(64);

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

function seedUri(db: SqliteDatabase, id: string, uri: string, iconUrl: string | null = null): void {
  upsertUriToken(db, {
    id,
    uri,
    uri_raw: Buffer.from(uri).toString('hex'),
    digest: null,
    issuer: ISSUER,
    owner: ISSUER,
    flags: 0,
    sell_offer: null,
    destination: null,
    burned: 0,
    burn_ledger: null,
    mint_ledger: 10,
    last_updated: 10,
    icon_url: iconUrl,
    uri_metadata: null,
    uri_meta_checked_ledger: null,
  });
}

describe('URIToken metadata', () => {
  it('stores a remarks image link and never accepts data URIs', () => {
    const db = memoryDb();
    applyClosedLedger(
      db,
      {
        index: 51,
        hash: '1'.repeat(64),
        closeTime: 1_700_000_051,
        transactions: [
          {
            hash: '11'.repeat(32),
            TransactionType: 'URITokenMint',
            Account: ISSUER,
            meta: {
              TransactionResult: 'tesSUCCESS',
              AffectedNodes: [
                {
                  CreatedNode: {
                    LedgerEntryType: 'URIToken',
                    LedgerIndex: URI_ID,
                    NewFields: {
                      URI: Buffer.from('https://nft.example/1.json').toString('hex'),
                      Issuer: ISSUER,
                      Owner: ISSUER,
                      Remarks: [
                        {
                          Remark: {
                            RemarkName: Buffer.from('image').toString('hex'),
                            RemarkValue: Buffer.from('https://cdn.example/nft.png').toString('hex'),
                          },
                        },
                      ],
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
    assert.equal(getUriToken(db, URI_ID)?.icon_url, 'https://cdn.example/nft.png');

    applyClosedLedger(
      db,
      {
        index: 52,
        hash: '2'.repeat(64),
        closeTime: 1_700_000_052,
        transactions: [
          {
            hash: '12'.repeat(32),
            TransactionType: 'SetRemarks',
            Account: ISSUER,
            ObjectID: URI_ID,
            Remarks: [
              {
                Remark: {
                  RemarkName: Buffer.from('icon').toString('hex'),
                  RemarkValue: Buffer.from('data:image/png;base64,AAAA').toString('hex'),
                },
              },
            ],
            meta: {
              TransactionResult: 'tesSUCCESS',
              AffectedNodes: [
                {
                  ModifiedNode: {
                    LedgerEntryType: 'URIToken',
                    LedgerIndex: URI_ID,
                    FinalFields: {
                      URI: Buffer.from('https://nft.example/1.json').toString('hex'),
                      Issuer: ISSUER,
                      Owner: ISSUER,
                      Remarks: [
                        {
                          Remark: {
                            RemarkName: Buffer.from('icon').toString('hex'),
                            RemarkValue: Buffer.from('data:image/png;base64,AAAA').toString('hex'),
                          },
                        },
                      ],
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
    assert.equal(getUriToken(db, URI_ID)?.icon_url, 'https://cdn.example/nft.png');
  });

  it('copies an image URI without fetching, and stores JSON metadata when the URI is a document', async () => {
    const db = memoryDb();
    seedUri(db, URI_ID, 'https://cdn.example/direct.webp');
    seedUri(db, META_ID, 'https://cdn.example/meta.json', 'https://cdn.example/already.png');
    const fetched: string[] = [];
    const document = { name: 'NFT', description: 'Cool', image: 'https://cdn.example/from-json.png' };

    const imageOnly = await refreshUriTokenMetadata({
      db,
      id: URI_ID,
      uri: 'https://cdn.example/direct.webp',
      iconUrl: null,
      ledger: 20,
      log: silentLog,
      loader: async (url) => {
        fetched.push(url);
        return { text: 'SHOULD_NOT_STORE', contentType: 'image/webp' };
      },
    });
    assert.equal(imageOnly.icon, 'https://cdn.example/direct.webp');
    assert.equal(imageOnly.metadata, null);
    assert.deepEqual(fetched, []);
    assert.equal(getUriToken(db, URI_ID)?.icon_url, 'https://cdn.example/direct.webp');
    assert.equal(getUriToken(db, URI_ID)?.uri_metadata, null);

    const stored = await runUriMetaPass({
      db,
      ledger: 20,
      log: silentLog,
      loader: async (url) => {
        fetched.push(url);
        return {
          text: JSON.stringify(document),
          contentType: 'application/json',
        };
      },
    });
    assert.equal(stored, 1);
    assert.deepEqual(fetched, ['https://cdn.example/meta.json']);
    const row = getUriToken(db, META_ID);
    assert.ok(row);
    assert.equal(row.icon_url, 'https://cdn.example/already.png');
    assert.deepEqual(JSON.parse(row.uri_metadata ?? ''), document);
  });
});
