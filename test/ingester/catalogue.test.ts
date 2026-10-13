import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { deflateSync } from 'node:zlib';

import { encode, unixTimeToRippleTime } from '@transia/xrpl';

import { ConfigError, loadConfig } from '../../src/config.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { listDexTrades } from '../../src/db/queries/dex.js';
import { getIndexerState, setIndexerState, upsertLedger } from '../../src/db/queries/indexer.js';
import {
  CATL_HEADER_SIZE,
  CATL_MAGIC,
  CATALOGUE_VERSION,
  CatalogueError,
  XAHAU_MAINNET_ID,
  decodeCatalogueTransactions,
  decodeVl,
  encodeVl,
  iterateCatalogueLedgers,
  listCatalogueFiles,
  parseCatlHeader,
  splitTxMeta,
  type CatalogueCheckpoint,
} from '../../src/ingester/catalogue.js';
import { HISTORY_CATALOGUE_CKPT, HISTORY_CATALOGUE_PATH, runCatalogueImport } from '../../src/ingester/catalogueImport.js';
import { zlibRandomAccessAvailable } from '../../src/ingester/zlibInflate.js';
import { HISTORY_DB_FROM, HISTORY_DB_NEXT, HISTORY_DB_STATUS, HISTORY_DB_THROUGH } from '../../src/ingester/historyDb.js';
import { silentLog, testConfig } from '../helpers.js';

const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
const MAKER = 'rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH';
const TAKER = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';
const PAIR = {
  baseCurrency: 'USD',
  baseIssuer: ISSUER,
  counterCurrency: 'XAH',
  counterIssuer: null,
};

const TN_ACCOUNT_STATE = 4;
const TN_TRANSACTION_MD = 3;
const TN_REMOVE = 254;
const TN_TERMINAL = 255;

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

function seedSnapshot(db: SqliteDatabase, ledger: number): void {
  setIndexerState(db, 'snapshot_status', 'complete');
  setIndexerState(db, 'snapshot_ledger', String(ledger));
  setIndexerState(db, 'live_from_ledger', String(ledger + 1));
  upsertLedger(db, {
    ledger_index: ledger,
    close_time: 1_700_000_000 + ledger,
    hash: 'f'.repeat(64),
    tx_count: 0,
    indexed_at: 1_700_000_000,
  });
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value);
  return buf;
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value);
  return buf;
}

function u64(value: number | bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return buf;
}

function i32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value);
  return buf;
}

function hexKey(hex: string): Buffer {
  return Buffer.from(hex, 'hex');
}

function catlHeader(options: {
  minLedger: number;
  maxLedger: number;
  compressionLevel?: number;
  networkId?: number;
}): Buffer {
  const versionField = CATALOGUE_VERSION | ((options.compressionLevel ?? 0) << 8);
  return Buffer.concat([
    u32(CATL_MAGIC),
    u32(options.minLedger),
    u32(options.maxLedger),
    u16(versionField),
    u16(options.networkId ?? XAHAU_MAINNET_ID),
    u64(0),
    Buffer.alloc(64),
  ]);
}

function ledgerHeader(seq: number, hash: Buffer, accountHash: Buffer): Buffer {
  return Buffer.concat([
    u32(seq),
    hash,
    Buffer.alloc(32),
    accountHash,
    Buffer.alloc(32),
    u64(0),
    i32(0),
    u32(10),
    u64(unixTimeToRippleTime((1_700_000_000 + seq) * 1000)),
    u64(0),
  ]);
}

function stateMap(): Buffer {
  const data = Buffer.from('state');
  return Buffer.concat([
    Buffer.from([TN_REMOVE]),
    Buffer.alloc(32, 9),
    Buffer.from([TN_ACCOUNT_STATE]),
    Buffer.alloc(32, 3),
    u32(data.length),
    data,
    Buffer.from([TN_TERMINAL]),
  ]);
}

function offerPayload(hash: string): { tx: Record<string, unknown>; meta: Record<string, unknown> } {
  return {
    tx: {
      TransactionType: 'OfferCreate',
      Account: TAKER,
      Fee: '12',
      Sequence: 1,
      SigningPubKey: '',
      TakerGets: '1000000',
      TakerPays: { currency: 'USD', issuer: ISSUER, value: '1' },
    },
    meta: {
      TransactionIndex: 0,
      TransactionResult: 'tesSUCCESS',
      AffectedNodes: [
        {
          ModifiedNode: {
            LedgerEntryType: 'Offer',
            LedgerIndex: hash.replace(/0/g, 'e').slice(0, 64).padEnd(64, 'e'),
            FinalFields: {
              Account: MAKER,
              TakerGets: '1000000',
              TakerPays: { currency: 'USD', issuer: ISSUER, value: '1' },
            },
            PreviousFields: {
              TakerGets: '2000000',
              TakerPays: { currency: 'USD', issuer: ISSUER, value: '2' },
            },
          },
        },
      ],
    },
  };
}

function encodeObject(value: Record<string, unknown>): Buffer {
  return Buffer.from(encode(value as Parameters<typeof encode>[0]), 'hex');
}

function txMdLeaf(hash: string, tx: Record<string, unknown>, meta: Record<string, unknown>): Buffer {
  const rawTxn = encodeObject(tx);
  const txnMeta = encodeObject(meta);
  const inner = Buffer.concat([encodeVl(rawTxn.length), rawTxn, encodeVl(txnMeta.length), txnMeta]);
  return Buffer.concat([Buffer.from([TN_TRANSACTION_MD]), hexKey(hash), u32(inner.length), inner]);
}

function txMap(leaves: Buffer[]): Buffer {
  return Buffer.concat([...leaves, Buffer.from([TN_TERMINAL])]);
}

interface CatLedgerSpec {
  seq: number;
  hash: string;
  accountHash: Buffer;
  txs?: Array<{ hash: string; tx: Record<string, unknown>; meta: Record<string, unknown> }>;
  writeState?: boolean;
}

function ledgerPayload(spec: CatLedgerSpec): Buffer {
  const parts = [ledgerHeader(spec.seq, hexKey(spec.hash), spec.accountHash)];
  if (spec.writeState !== false) {
    parts.push(stateMap());
  }
  parts.push(txMap((spec.txs ?? []).map((tx) => txMdLeaf(tx.hash, tx.tx, tx.meta))));
  return Buffer.concat(parts);
}

function writeCatalogue(options: {
  minLedger: number;
  maxLedger: number;
  ledgers: CatLedgerSpec[];
  compressionLevel?: number;
  networkId?: number;
  dir?: string;
  splitZlibAfter?: number;
}): string {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'xahauindex-cat-'));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `cat.${options.minLedger}-${options.maxLedger}`);
  const level = options.compressionLevel ?? 0;
  let body: Buffer;
  if (level > 0 && options.splitZlibAfter !== undefined) {
    const split = options.splitZlibAfter;
    const first = Buffer.concat(options.ledgers.slice(0, split).map((ledger) => ledgerPayload(ledger)));
    const rest = Buffer.concat(options.ledgers.slice(split).map((ledger) => ledgerPayload(ledger)));
    body = Buffer.concat([deflateSync(first, { level }), deflateSync(rest, { level })]);
  } else {
    const payload = Buffer.concat(options.ledgers.map((ledger) => ledgerPayload(ledger)));
    body = level > 0 ? deflateSync(payload, { level }) : payload;
  }
  const file = Buffer.concat([
    catlHeader({
      minLedger: options.minLedger,
      maxLedger: options.maxLedger,
      compressionLevel: level,
      networkId: options.networkId,
    }),
    body,
  ]);
  writeFileSync(path, file);
  return path;
}

describe('parseCatlHeader', () => {
  it('reads a CATL v1 header', () => {
    const buf = catlHeader({ minLedger: 1, maxLedger: 20, compressionLevel: 6, networkId: XAHAU_MAINNET_ID });
    assert.equal(buf.length, CATL_HEADER_SIZE);
    const header = parseCatlHeader(buf);
    assert.equal(header.minLedger, 1);
    assert.equal(header.maxLedger, 20);
    assert.equal(header.version, 1);
    assert.equal(header.compressionLevel, 6);
    assert.equal(header.networkId, XAHAU_MAINNET_ID);
    assert.equal(header.filesize, 0n);
  });

  it('rejects truncated, unmagic, unsupported, and inverted ranges', () => {
    assert.throws(() => parseCatlHeader(Buffer.alloc(10)), CatalogueError);
    const badMagic = catlHeader({ minLedger: 1, maxLedger: 2 });
    badMagic.writeUInt32LE(0, 0);
    assert.throws(() => parseCatlHeader(badMagic), CatalogueError);
    const badVersion = catlHeader({ minLedger: 1, maxLedger: 2 });
    badVersion.writeUInt16LE(2, 12);
    assert.throws(() => parseCatlHeader(badVersion), CatalogueError);
    assert.throws(() => parseCatlHeader(catlHeader({ minLedger: 9, maxLedger: 1 })), CatalogueError);
  });
});

describe('VL', () => {
  it('round-trips 1-, 2-, and 3-byte prefixes', () => {
    for (const length of [0, 1, 192, 193, 12_480, 12_481, 50_000]) {
      const encoded = encodeVl(length);
      const decoded = decodeVl(encoded, 0);
      assert.equal(decoded.length, length);
      assert.equal(decoded.prefix, encoded.length);
    }
  });
});

describe('splitTxMeta', () => {
  it('splits VL(tx)+VL(meta) and reports a missing meta', () => {
    const tx = Buffer.from('abcd', 'hex');
    const meta = Buffer.from('ef', 'hex');
    const both = Buffer.concat([encodeVl(tx.length), tx, encodeVl(meta.length), meta]);
    const split = splitTxMeta(both);
    assert.equal(split.rawTxn.toString('hex'), 'abcd');
    assert.equal(split.txnMeta?.toString('hex'), 'ef');
    const txOnly = Buffer.concat([encodeVl(tx.length), tx]);
    assert.equal(splitTxMeta(txOnly).txnMeta, null);
  });
});

describe('iterateCatalogueLedgers', () => {
  it('reads uncompressed and zlib catalogues, skipping unchanged state', async () => {
    const accountA = Buffer.alloc(32, 1);
    const accountB = Buffer.alloc(32, 2);
    const offer = offerPayload('aa'.repeat(32));
    const ledgers: CatLedgerSpec[] = [
      {
        seq: 40,
        hash: '11'.repeat(32),
        accountHash: accountA,
        writeState: true,
        txs: [{ hash: 'aa'.repeat(32), tx: offer.tx, meta: offer.meta }],
      },
      {
        seq: 41,
        hash: '22'.repeat(32),
        accountHash: accountA,
        writeState: false,
        txs: [],
      },
      {
        seq: 42,
        hash: '33'.repeat(32),
        accountHash: accountB,
        writeState: true,
        txs: [],
      },
    ];
    const rawPath = writeCatalogue({ minLedger: 40, maxLedger: 42, ledgers });
    const zlibPath = writeCatalogue({ minLedger: 40, maxLedger: 42, ledgers, compressionLevel: 6 });

    const raw = [];
    for await (const item of iterateCatalogueLedgers(rawPath)) {
      raw.push(item);
    }
    const compressed = [];
    for await (const item of iterateCatalogueLedgers(zlibPath)) {
      compressed.push(item);
    }
    assert.equal(raw.length, 3);
    assert.equal(compressed.length, 3);
    assert.equal(raw[0]?.header.compressionLevel, 0);
    assert.equal(compressed[0]?.header.compressionLevel, 6);
    assert.deepEqual(
      raw.map((item) => item.ledger.index),
      [40, 41, 42],
    );
    assert.equal(raw[0]?.ledger.blobs.length, 1);
    assert.equal(raw[1]?.ledger.blobs.length, 0);
    assert.equal(raw[0]?.ledger.hash, '11'.repeat(32).toUpperCase());
    assert.equal(raw[0]?.ledger.blobs[0]?.hash, 'AA'.repeat(32));
    const decoded = decodeCatalogueTransactions(raw[0]?.ledger.blobs ?? []);
    assert.equal(decoded.length, 1);
    assert.equal((decoded[0] as { TransactionType: string }).TransactionType, 'OfferCreate');
  });

  it('resumes uncompressed and zlib streams from a checkpoint', async () => {
    const accountA = Buffer.alloc(32, 1);
    const accountB = Buffer.alloc(32, 2);
    const ledgers: CatLedgerSpec[] = [
      {
        seq: 40,
        hash: '11'.repeat(32),
        accountHash: accountA,
        writeState: true,
        txs: [],
      },
      {
        seq: 41,
        hash: '22'.repeat(32),
        accountHash: accountA,
        writeState: false,
        txs: [],
      },
      {
        seq: 42,
        hash: '33'.repeat(32),
        accountHash: accountB,
        writeState: true,
        txs: [],
      },
    ];
    async function resumeFrom(path: string): Promise<void> {
      let checkpoint: CatalogueCheckpoint | undefined;
      for await (const item of iterateCatalogueLedgers(path)) {
        if (item.ledger.index === 41) {
          checkpoint = await item.checkpoint();
          break;
        }
      }
      assert.ok(checkpoint);
      assert.equal(checkpoint.nextSeq, 42);
      assert.ok(checkpoint.inputOffset > CATL_HEADER_SIZE);
      const seqs: number[] = [];
      for await (const item of iterateCatalogueLedgers(path, { resume: checkpoint })) {
        seqs.push(item.ledger.index);
      }
      assert.deepEqual(seqs, [42]);
    }
    await resumeFrom(writeCatalogue({ minLedger: 40, maxLedger: 42, ledgers }));
    if (zlibRandomAccessAvailable()) {
      await resumeFrom(writeCatalogue({ minLedger: 40, maxLedger: 42, ledgers, compressionLevel: 6 }));
    }
  });

  it('skipUntil does not yield ledgers before the resume cursor', async () => {
    const account = Buffer.alloc(32, 1);
    const path = writeCatalogue({
      minLedger: 40,
      maxLedger: 42,
      ledgers: [
        {
          seq: 40,
          hash: '11'.repeat(32),
          accountHash: account,
          writeState: true,
          txs: [],
        },
        {
          seq: 41,
          hash: '22'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [],
        },
        {
          seq: 42,
          hash: '33'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [],
        },
      ],
    });
    const seqs: number[] = [];
    for await (const item of iterateCatalogueLedgers(path, { skipUntil: 42, decodeFrom: 42 })) {
      seqs.push(item.ledger.index);
    }
    assert.deepEqual(seqs, [42]);
  });

  it('skip-scans a zlib catalogue with checkpoints without losing later ledgers', async () => {
    if (!zlibRandomAccessAvailable()) {
      return;
    }
    const ledgers: CatLedgerSpec[] = [];
    for (let seq = 100; seq <= 180; seq += 1) {
      ledgers.push({
        seq,
        hash: seq.toString(16).padStart(64, '0'),
        accountHash: Buffer.alloc(32, seq % 250),
        writeState: true,
        txs: [],
      });
    }
    const path = writeCatalogue({ minLedger: 100, maxLedger: 180, ledgers, compressionLevel: 6 });
    const seqs: number[] = [];
    let checkpoints = 0;
    for await (const item of iterateCatalogueLedgers(path, {
      skipUntil: 175,
      decodeFrom: 175,
      skipCheckpointEvery: 5,
      onSkipProgress: async (info) => {
        checkpoints += 1;
        await info.checkpoint();
      },
    })) {
      seqs.push(item.ledger.index);
    }
    assert.ok(checkpoints > 0);
    assert.deepEqual(seqs, [175, 176, 177, 178, 179, 180]);
  });

  it('skip-scans past a concatenated zlib member into later ledgers', async () => {
    const ledgers: CatLedgerSpec[] = [];
    for (let seq = 40; seq <= 45; seq += 1) {
      ledgers.push({
        seq,
        hash: seq.toString(16).padStart(64, '0'),
        accountHash: Buffer.alloc(32, seq >= 43 ? 2 : 1),
        writeState: seq === 40 || seq === 43,
        txs: [],
      });
    }
    const path = writeCatalogue({
      minLedger: 40,
      maxLedger: 45,
      ledgers,
      compressionLevel: 6,
      splitZlibAfter: 3,
    });
    const seqs: number[] = [];
    for await (const item of iterateCatalogueLedgers(path, { skipUntil: 44, decodeFrom: 44 })) {
      seqs.push(item.ledger.index);
    }
    assert.deepEqual(seqs, [44, 45]);
  });
});

describe('listCatalogueFiles', () => {
  it('lists CATL files in a directory and ignores other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xahauindex-catdir-'));
    const first = writeCatalogue({
      minLedger: 1,
      maxLedger: 1,
      dir,
      ledgers: [
        {
          seq: 1,
          hash: '11'.repeat(32),
          accountHash: Buffer.alloc(32, 1),
          writeState: true,
          txs: [],
        },
      ],
    });
    const second = writeCatalogue({
      minLedger: 40,
      maxLedger: 40,
      dir,
      ledgers: [
        {
          seq: 40,
          hash: '22'.repeat(32),
          accountHash: Buffer.alloc(32, 2),
          writeState: true,
          txs: [],
        },
      ],
    });
    writeFileSync(join(dir, 'notes.txt'), 'not a catalogue');
    const files = await listCatalogueFiles(dir);
    assert.deepEqual(
      files.map((file) => file.path),
      [first, second],
    );
    const single = await listCatalogueFiles(first);
    assert.equal(single.length, 1);
    assert.equal(single[0]?.path, first);
  });
});

describe('runCatalogueImport', () => {
  it('imports OfferCreate fills, skips AccountSet, and does not re-import a contained file', async () => {
    const account = Buffer.alloc(32, 1);
    const fill = offerPayload('aa'.repeat(32));
    const skipped = {
      tx: {
        TransactionType: 'AccountSet',
        Account: TAKER,
        Fee: '12',
        Sequence: 2,
        SigningPubKey: '',
      },
      meta: {
        TransactionIndex: 0,
        TransactionResult: 'tesSUCCESS',
        AffectedNodes: [],
      },
    };
    const path = writeCatalogue({
      minLedger: 40,
      maxLedger: 42,
      ledgers: [
        {
          seq: 40,
          hash: '11'.repeat(32),
          accountHash: account,
          writeState: true,
          txs: [{ hash: 'aa'.repeat(32), tx: fill.tx, meta: fill.meta }],
        },
        {
          seq: 41,
          hash: '22'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [{ hash: 'bb'.repeat(32), tx: skipped.tx, meta: skipped.meta }],
        },
        {
          seq: 42,
          hash: '33'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [],
        },
      ],
    });
    const db = memoryDb();
    seedSnapshot(db, 50);
    const result = await runCatalogueImport({
      db,
      config: testConfig({ historyCatalogue: path, backfillFromLedger: 1 }),
      log: silentLog,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.from, 40);
    assert.equal(result.through, 42);
    assert.equal(result.decoded, 1);
    assert.equal(listDexTrades(db, PAIR, { limit: 10 }).length, 1);
    assert.equal(listDexTrades(db, PAIR, { limit: 10 })[0]?.tx_hash, 'AA'.repeat(32));
    assert.equal(getIndexerState(db, HISTORY_DB_STATUS), 'complete');
    assert.equal(getIndexerState(db, HISTORY_DB_NEXT), '43');
    assert.equal(getIndexerState(db, HISTORY_CATALOGUE_PATH), path);

    const again = await runCatalogueImport({
      db,
      config: testConfig({ historyCatalogue: path, backfillFromLedger: 1 }),
      log: silentLog,
    });
    assert.equal(again.skipped, true);
    assert.equal(listDexTrades(db, PAIR, { limit: 10 }).length, 1);
  });

  it('resumes at history_db_next and skips ledgers already in SQLite', async () => {
    const account = Buffer.alloc(32, 1);
    const first = offerPayload('aa'.repeat(32));
    const second = offerPayload('cc'.repeat(32));
    const path = writeCatalogue({
      minLedger: 40,
      maxLedger: 42,
      ledgers: [
        {
          seq: 40,
          hash: '11'.repeat(32),
          accountHash: account,
          writeState: true,
          txs: [{ hash: 'aa'.repeat(32), tx: first.tx, meta: first.meta }],
        },
        {
          seq: 41,
          hash: '22'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [],
        },
        {
          seq: 42,
          hash: '33'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [{ hash: 'cc'.repeat(32), tx: second.tx, meta: second.meta }],
        },
      ],
    });
    const db = memoryDb();
    seedSnapshot(db, 50);
    upsertLedger(db, {
      ledger_index: 41,
      close_time: 1_700_000_041,
      hash: '22'.repeat(32),
      tx_count: 0,
      indexed_at: 1_700_000_000,
    });
    setIndexerState(db, HISTORY_DB_STATUS, 'running');
    setIndexerState(db, HISTORY_DB_FROM, '40');
    setIndexerState(db, HISTORY_DB_THROUGH, '42');
    setIndexerState(db, HISTORY_DB_NEXT, '41');
    const result = await runCatalogueImport({
      db,
      config: testConfig({ historyCatalogue: path, backfillFromLedger: 1 }),
      log: silentLog,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.decoded, 1);
    const trades = listDexTrades(db, PAIR, { limit: 10 });
    assert.equal(trades.length, 1);
    assert.equal(trades[0]?.tx_hash, 'CC'.repeat(32));
    assert.equal(getIndexerState(db, HISTORY_DB_NEXT), '43');
  });

  it('unions sequential catalogue files into one imported range', async () => {
    const account = Buffer.alloc(32, 1);
    const first = offerPayload('aa'.repeat(32));
    const second = offerPayload('dd'.repeat(32));
    const firstPath = writeCatalogue({
      minLedger: 40,
      maxLedger: 41,
      ledgers: [
        {
          seq: 40,
          hash: '11'.repeat(32),
          accountHash: account,
          writeState: true,
          txs: [{ hash: 'aa'.repeat(32), tx: first.tx, meta: first.meta }],
        },
        {
          seq: 41,
          hash: '22'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [],
        },
      ],
    });
    const secondPath = writeCatalogue({
      minLedger: 42,
      maxLedger: 42,
      ledgers: [
        {
          seq: 42,
          hash: '33'.repeat(32),
          accountHash: account,
          writeState: true,
          txs: [{ hash: 'dd'.repeat(32), tx: second.tx, meta: second.meta }],
        },
      ],
    });
    const db = memoryDb();
    seedSnapshot(db, 50);
    await runCatalogueImport({
      db,
      config: testConfig({ historyCatalogue: firstPath, backfillFromLedger: 1 }),
      log: silentLog,
    });
    const secondResult = await runCatalogueImport({
      db,
      config: testConfig({ historyCatalogue: secondPath, backfillFromLedger: 1 }),
      log: silentLog,
    });
    assert.equal(secondResult.skipped, false);
    assert.equal(secondResult.from, 40);
    assert.equal(secondResult.through, 42);
    assert.equal(getIndexerState(db, HISTORY_DB_FROM), '40');
    assert.equal(getIndexerState(db, HISTORY_DB_THROUGH), '42');
    assert.equal(listDexTrades(db, PAIR, { limit: 10 }).length, 2);
  });

  it('imports every CATL in a directory in ledger order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'xahauindex-catdir-'));
    const account = Buffer.alloc(32, 1);
    const first = offerPayload('aa'.repeat(32));
    const second = offerPayload('dd'.repeat(32));
    writeCatalogue({
      minLedger: 40,
      maxLedger: 41,
      dir,
      ledgers: [
        {
          seq: 40,
          hash: '11'.repeat(32),
          accountHash: account,
          writeState: true,
          txs: [{ hash: 'aa'.repeat(32), tx: first.tx, meta: first.meta }],
        },
        {
          seq: 41,
          hash: '22'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [],
        },
      ],
    });
    writeCatalogue({
      minLedger: 42,
      maxLedger: 42,
      dir,
      ledgers: [
        {
          seq: 42,
          hash: '33'.repeat(32),
          accountHash: account,
          writeState: true,
          txs: [{ hash: 'dd'.repeat(32), tx: second.tx, meta: second.meta }],
        },
      ],
    });
    writeFileSync(join(dir, 'readme.txt'), 'ignore me');
    const db = memoryDb();
    seedSnapshot(db, 50);
    const result = await runCatalogueImport({
      db,
      config: testConfig({ historyCatalogue: dir, backfillFromLedger: 1 }),
      log: silentLog,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.from, 40);
    assert.equal(result.through, 42);
    assert.equal(getIndexerState(db, HISTORY_DB_FROM), '40');
    assert.equal(getIndexerState(db, HISTORY_DB_THROUGH), '42');
    assert.equal(getIndexerState(db, HISTORY_CATALOGUE_PATH), dir);
    assert.equal(listDexTrades(db, PAIR, { limit: 10 }).length, 2);
  });

  it('restarts a zlib file from the beginning when a checkpoint misses the payload', async () => {
    if (!zlibRandomAccessAvailable()) {
      return;
    }
    const account = Buffer.alloc(32, 1);
    const path = writeCatalogue({
      minLedger: 40,
      maxLedger: 42,
      compressionLevel: 6,
      ledgers: [
        {
          seq: 40,
          hash: '11'.repeat(32),
          accountHash: account,
          writeState: true,
          txs: [],
        },
        {
          seq: 41,
          hash: '22'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [],
        },
        {
          seq: 42,
          hash: '33'.repeat(32),
          accountHash: account,
          writeState: false,
          txs: [],
        },
      ],
    });
    const db = memoryDb();
    seedSnapshot(db, 50);
    setIndexerState(db, HISTORY_DB_STATUS, 'running');
    setIndexerState(db, HISTORY_DB_FROM, '40');
    setIndexerState(db, HISTORY_DB_THROUGH, '42');
    setIndexerState(db, HISTORY_DB_NEXT, '42');
    setIndexerState(
      db,
      HISTORY_CATALOGUE_CKPT,
      JSON.stringify({
        path,
        nextSeq: 41,
        prevAccountHash: account.toString('hex').toUpperCase(),
        pending: '',
        inputOffset: 99_999_999,
        bits: 0,
        window: Buffer.alloc(32_768).toString('base64'),
      }),
    );
    const result = await runCatalogueImport({
      db,
      config: testConfig({ historyCatalogue: path, backfillFromLedger: 1 }),
      log: silentLog,
    });
    assert.equal(result.skipped, false);
    assert.equal(getIndexerState(db, HISTORY_DB_NEXT), '43');
    assert.equal(getIndexerState(db, HISTORY_CATALOGUE_CKPT), '');
  });

  it('skips import when the snapshot is not complete', async () => {
    const path = writeCatalogue({
      minLedger: 1,
      maxLedger: 1,
      ledgers: [
        {
          seq: 1,
          hash: '11'.repeat(32),
          accountHash: Buffer.alloc(32, 1),
          writeState: true,
          txs: [],
        },
      ],
    });
    const db = memoryDb();
    const result = await runCatalogueImport({
      db,
      config: testConfig({ historyCatalogue: path, backfillFromLedger: 1 }),
      log: silentLog,
    });
    assert.equal(result.skipped, true);
    assert.equal(result.from, null);
  });
});

describe('loadConfig HISTORY_CATALOGUE', () => {
  it('defaults the catalogue importer off and reads a file without BACKFILL_FROM_DB', () => {
    const config = loadConfig({});
    assert.equal(config.historyCatalogue, null);
    const path = writeCatalogue({
      minLedger: 1,
      maxLedger: 1,
      ledgers: [
        {
          seq: 1,
          hash: '11'.repeat(32),
          accountHash: Buffer.alloc(32, 1),
          writeState: true,
          txs: [],
        },
      ],
    });
    const loaded = loadConfig({ HISTORY_CATALOGUE: path });
    assert.equal(loaded.historyFromDb, false);
    assert.equal(loaded.historyCatalogue, path);
    const dir = mkdtempSync(join(tmpdir(), 'xahauindex-catdir-'));
    assert.equal(loadConfig({ HISTORY_CATALOGUE: dir }).historyCatalogue, dir);
    assert.throws(() => loadConfig({ HISTORY_CATALOGUE: join(tmpdir(), 'missing.cat') }), ConfigError);
  });
});
