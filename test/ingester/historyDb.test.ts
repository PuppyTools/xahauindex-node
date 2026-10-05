import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import Database from 'better-sqlite3';
import { encode, unixTimeToRippleTime } from '@transia/xrpl';

import {
  DEFAULT_HISTORY_BATCH_SIZE,
  DEFAULT_HISTORY_WORKERS,
  loadConfig,
  ConfigError,
} from '../../src/config.js';
import { closeDatabase, openDatabase, type SqliteDatabase } from '../../src/db/client.js';
import { listDexTrades } from '../../src/db/queries/dex.js';
import { getIndexerState, setIndexerState, upsertLedger } from '../../src/db/queries/indexer.js';
import { decodeHistoryTransaction } from '../../src/ingester/historyDecode.js';
import { historyImportTargetRange, runHistoryDbImport } from '../../src/ingester/historyDb.js';
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

function createHistoryFiles(): { dir: string; ledgerPath: string; txPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'xahauindex-history-'));
  const ledgerPath = join(dir, 'ledger.db');
  const txPath = join(dir, 'transaction.db');
  const ledger = new Database(ledgerPath);
  ledger.exec(`
    CREATE TABLE Ledgers (
      LedgerHash CHARACTER(64) PRIMARY KEY,
      LedgerSeq BIGINT UNSIGNED,
      PrevHash CHARACTER(64),
      TotalCoins BIGINT UNSIGNED,
      ClosingTime BIGINT UNSIGNED,
      PrevClosingTime BIGINT UNSIGNED,
      CloseTimeRes BIGINT UNSIGNED,
      CloseFlags BIGINT UNSIGNED,
      AccountSetHash CHARACTER(64),
      TransSetHash CHARACTER(64)
    );
    CREATE INDEX SeqLedger ON Ledgers(LedgerSeq);
  `);
  ledger.close();
  const tx = new Database(txPath);
  tx.exec(`
    CREATE TABLE Transactions (
      TransID CHARACTER(64) PRIMARY KEY,
      TransType CHARACTER(24),
      FromAcct CHARACTER(35),
      FromSeq BIGINT UNSIGNED,
      LedgerSeq BIGINT UNSIGNED,
      Status CHARACTER(1),
      RawTxn BLOB,
      TxnMeta BLOB
    );
    CREATE INDEX TxLgrIndex ON Transactions(LedgerSeq);
  `);
  tx.close();
  return { dir, ledgerPath, txPath };
}

function insertHistoryLedger(
  files: { ledgerPath: string; txPath: string },
  seq: number,
  hash: string,
  type: string,
  rawTxn: Buffer,
  txnMeta: Buffer,
  status = 'V',
): void {
  const ledger = new Database(files.ledgerPath);
  const tx = new Database(files.txPath);
  try {
    ledger
      .prepare(
        `INSERT INTO Ledgers (LedgerHash, LedgerSeq, PrevHash, TotalCoins, ClosingTime, PrevClosingTime, CloseTimeRes, CloseFlags, AccountSetHash, TransSetHash)
         VALUES (?, ?, ?, 0, ?, 0, 10, 0, ?, ?)`,
      )
      .run(
        seq.toString(16).padStart(64, '0'),
        seq,
        '0'.repeat(64),
        unixTimeToRippleTime((1_700_000_000 + seq) * 1000),
        '0'.repeat(64),
        '0'.repeat(64),
      );
    tx.prepare(
      `INSERT INTO Transactions (TransID, TransType, FromAcct, FromSeq, LedgerSeq, Status, RawTxn, TxnMeta)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?)`,
    ).run(hash, type, TAKER, seq, status, rawTxn, txnMeta);
  } finally {
    ledger.close();
    tx.close();
  }
}

describe('historyImportTargetRange', () => {
  it('caps the dump at the snapshot and the FROM bound', () => {
    assert.deepEqual(historyImportTargetRange({ from: 1, through: 100 }, 80, 40), { from: 40, through: 80 });
    assert.equal(historyImportTargetRange({ from: 90, through: 100 }, 80, 1), null);
    assert.deepEqual(historyImportTargetRange({ from: 10, through: 20 }, 50, null), { from: 10, through: 20 });
  });
});

describe('decodeHistoryTransaction', () => {
  it('round-trips an encoded OfferCreate and metadata', () => {
    const hash = 'a'.repeat(64);
    const payload = offerPayload(hash);
    const decoded = decodeHistoryTransaction({
      transId: hash,
      rawTxn: Buffer.from(encode(payload.tx as Parameters<typeof encode>[0]), 'hex'),
      txnMeta: Buffer.from(encode(payload.meta as Parameters<typeof encode>[0]), 'hex'),
    });
    assert.ok(decoded);
    const record = decoded as { hash: string; TransactionType: string; meta: { TransactionResult: string } };
    assert.equal(record.hash, hash);
    assert.equal(record.TransactionType, 'OfferCreate');
    assert.equal(record.meta.TransactionResult, 'tesSUCCESS');
  });
});

describe('runHistoryDbImport', () => {
  it('imports OfferCreate fills and skips Invoke rows and non-V status', async () => {
    const files = createHistoryFiles();
    const fill = offerPayload('a'.repeat(64));
    const skipped = offerPayload('b'.repeat(64));
    const local = offerPayload('c'.repeat(64));
    insertHistoryLedger(
      files,
      40,
      'a'.repeat(64),
      'OfferCreate',
      Buffer.from(encode(fill.tx as Parameters<typeof encode>[0]), 'hex'),
      Buffer.from(encode(fill.meta as Parameters<typeof encode>[0]), 'hex'),
    );
    insertHistoryLedger(
      files,
      41,
      'b'.repeat(64),
      'Invoke',
      Buffer.from(encode(skipped.tx as Parameters<typeof encode>[0]), 'hex'),
      Buffer.from(encode(skipped.meta as Parameters<typeof encode>[0]), 'hex'),
    );
    insertHistoryLedger(
      files,
      42,
      'c'.repeat(64),
      'OfferCreate',
      Buffer.from(encode(local.tx as Parameters<typeof encode>[0]), 'hex'),
      Buffer.from(encode(local.meta as Parameters<typeof encode>[0]), 'hex'),
      'L',
    );
    const db = memoryDb();
    seedSnapshot(db, 50);
    const result = await runHistoryDbImport({
      db,
      config: testConfig({
        historyFromDb: true,
        historyLedgerDb: files.ledgerPath,
        historyTxDb: files.txPath,
        backfillFromLedger: 1,
        historyBatchSize: 2,
        historyWorkers: 2,
      }),
      log: silentLog,
    });
    assert.equal(result.skipped, false);
    assert.equal(result.from, 40);
    assert.equal(result.through, 42);
    assert.equal(result.decoded, 1);
    assert.equal(listDexTrades(db, PAIR, { limit: 10 }).length, 1);
    assert.equal(listDexTrades(db, PAIR, { limit: 10 })[0]?.tx_hash, 'a'.repeat(64));
    assert.equal(getIndexerState(db, 'history_db_status'), 'complete');
    assert.equal(getIndexerState(db, 'history_db_next'), '43');

    const again = await runHistoryDbImport({
      db,
      config: testConfig({
        historyFromDb: true,
        historyLedgerDb: files.ledgerPath,
        historyTxDb: files.txPath,
        backfillFromLedger: 1,
      }),
      log: silentLog,
    });
    assert.equal(again.skipped, true);
    assert.equal(listDexTrades(db, PAIR, { limit: 10 }).length, 1);
  });
});

describe('loadConfig history DB', () => {
  it('defaults the importer off', () => {
    const config = loadConfig({});
    assert.equal(config.historyFromDb, false);
    assert.equal(config.historyLedgerDb, null);
    assert.equal(config.historyTxDb, null);
    assert.equal(config.historyBatchSize, DEFAULT_HISTORY_BATCH_SIZE);
    assert.equal(config.historyWorkers, DEFAULT_HISTORY_WORKERS);
  });

  it('requires existing dump files when BACKFILL_FROM_DB is on', () => {
    assert.throws(() => loadConfig({ BACKFILL_FROM_DB: 'true' }), ConfigError);
    const files = createHistoryFiles();
    const config = loadConfig({
      BACKFILL_FROM_DB: '1',
      HISTORY_LEDGER_DB: files.ledgerPath,
      HISTORY_TX_DB: files.txPath,
      HISTORY_BATCH_SIZE: '250',
      HISTORY_WORKERS: '8',
    });
    assert.equal(config.historyFromDb, true);
    assert.equal(config.historyLedgerDb, files.ledgerPath);
    assert.equal(config.historyTxDb, files.txPath);
    assert.equal(config.historyBatchSize, 250);
    assert.equal(config.historyWorkers, 8);
  });
});
