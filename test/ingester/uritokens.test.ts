import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { buildApi } from '../../src/api/index.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { setIndexerState } from '../../src/db/queries/indexer.js';
import { listRemarksByUriToken } from '../../src/db/queries/remarks.js';
import { getUriToken, listUriTokenTransfers } from '../../src/db/queries/uritokens.js';
import { applyClosedLedger } from '../../src/ingester/ledger.js';
import type { ClosedLedger } from '../../src/ingester/source.js';
import { silentLog, testConfig, testRuntime } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const HOLDER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const BUYER = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH';
const URI_ID = 'A'.repeat(64);
const URI_HEX = Buffer.from('https://nft.example/1').toString('hex');

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

function hexRemark(name: string, value?: string): unknown {
  const inner: Record<string, string> = {
    RemarkName: Buffer.from(name).toString('hex'),
  };
  if (value !== undefined) {
    inner.RemarkValue = Buffer.from(value).toString('hex');
  }
  return { Remark: inner };
}

function uriFields(owner: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    URI: URI_HEX,
    Issuer: ISSUER,
    Owner: owner,
    Digest: 'E'.repeat(64),
    Flags: 0,
    ...extra,
  };
}

describe('URIToken live lifecycle', () => {
  it('mints, remarks, lists, sells, buys, and burns', async () => {
    const db = memoryDb();
    setIndexerState(db, 'snapshot_status', 'complete');
    setIndexerState(db, 'snapshot_ledger', '50');
    setIndexerState(db, 'live_from_ledger', '51');

    applyClosedLedger(
      db,
      closedLedger(51, [
        {
          hash: '11'.repeat(32),
          TransactionType: 'URITokenMint',
          Account: ISSUER,
          URI: URI_HEX,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                CreatedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: URI_ID,
                  NewFields: uriFields(ISSUER),
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );
    assert.equal(getUriToken(db, URI_ID)?.owner, ISSUER);
    assert.equal(getUriToken(db, URI_ID)?.mint_ledger, 51);

    applyClosedLedger(
      db,
      closedLedger(52, [
        {
          hash: '12'.repeat(32),
          TransactionType: 'SetRemarks',
          Account: ISSUER,
          ObjectID: URI_ID,
          Remarks: [hexRemark('name', 'Cool NFT'), hexRemark('website', 'https://nft.example')],
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                ModifiedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: URI_ID,
                  FinalFields: uriFields(ISSUER, {
                    Remarks: [hexRemark('name', 'Cool NFT'), hexRemark('website', 'https://nft.example')],
                  }),
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );

    applyClosedLedger(
      db,
      closedLedger(53, [
        {
          hash: '13'.repeat(32),
          TransactionType: 'URITokenCreateSellOffer',
          Account: ISSUER,
          URITokenID: URI_ID,
          Amount: '1000000',
          Destination: HOLDER,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                ModifiedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: URI_ID,
                  FinalFields: uriFields(ISSUER, { Amount: '1000000', Destination: HOLDER }),
                  PreviousFields: {},
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );
    assert.equal(getUriToken(db, URI_ID)?.sell_offer, '1000000');
    assert.equal(getUriToken(db, URI_ID)?.destination, HOLDER);

    applyClosedLedger(
      db,
      closedLedger(54, [
        {
          hash: '14'.repeat(32),
          TransactionType: 'URITokenBuy',
          Account: BUYER,
          URITokenID: URI_ID,
          Amount: '1000000',
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                ModifiedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: URI_ID,
                  FinalFields: uriFields(BUYER),
                  PreviousFields: { Owner: ISSUER, Amount: '1000000', Destination: HOLDER },
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );
    const afterBuy = getUriToken(db, URI_ID);
    assert.ok(afterBuy);
    assert.equal(afterBuy.owner, BUYER);
    assert.equal(afterBuy.sell_offer, null);
    assert.equal(afterBuy.destination, null);
    const transfers = listUriTokenTransfers(db, URI_ID);
    assert.equal(transfers.length, 1);
    assert.equal(transfers[0]?.from_account, ISSUER);
    assert.equal(transfers[0]?.to_account, BUYER);
    assert.equal(transfers[0]?.price, '1000000');

    applyClosedLedger(
      db,
      closedLedger(55, [
        {
          hash: '15'.repeat(32),
          TransactionType: 'SetRemarks',
          Account: BUYER,
          ObjectID: URI_ID,
          Remarks: [hexRemark('website')],
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                ModifiedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: URI_ID,
                  FinalFields: uriFields(BUYER, { Remarks: [hexRemark('name', 'Cool NFT')] }),
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );
    const remarks = listRemarksByUriToken(db, URI_ID);
    assert.equal(remarks.some((row) => row.name === 'website'), false);
    assert.equal(remarks.some((row) => row.name === 'name' && row.value === 'Cool NFT'), true);

    applyClosedLedger(
      db,
      closedLedger(56, [
        {
          hash: '16'.repeat(32),
          TransactionType: 'URITokenBurn',
          Account: BUYER,
          URITokenID: URI_ID,
          meta: {
            TransactionResult: 'tesSUCCESS',
            AffectedNodes: [
              {
                DeletedNode: {
                  LedgerEntryType: 'URIToken',
                  LedgerIndex: URI_ID,
                  FinalFields: uriFields(BUYER),
                },
              },
            ],
          },
        },
      ]),
      silentLog,
    );
    const burned = getUriToken(db, URI_ID);
    assert.ok(burned);
    assert.equal(burned.burned, 1);
    assert.equal(burned.burn_ledger, 56);
    assert.equal(burned.owner, BUYER);

    const app = await buildApi({
      db,
      config: testConfig(),
      runtime: testRuntime({ networkLedgerIndex: 56 }),
    });
    const nftRes = await app.inject({ method: 'GET', url: `/v1/uritokens/${URI_ID}` });
    assert.equal(nftRes.statusCode, 200);
    const body = nftRes.json() as {
      data: {
        burned: boolean;
        owner: string;
        remarks: Record<string, string>;
        transfers: Array<{ from_account: string; to_account: string }>;
      };
    };
    assert.equal(body.data.burned, true);
    assert.equal(body.data.owner, BUYER);
    assert.equal(body.data.remarks.name, 'Cool NFT');
    assert.equal(body.data.remarks.website, undefined);
    assert.equal(body.data.transfers.length, 1);
    await app.close();
  });
});
