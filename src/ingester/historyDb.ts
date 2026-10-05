import { existsSync } from 'node:fs';

import Database from 'better-sqlite3';
import { rippleTimeToUnixTime } from '@transia/xrpl';

import { resolveBackfillFrom, type Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, setIndexerState } from '../db/queries/indexer.js';
import { decodeHistoryTransactions, HISTORY_TX_TYPE_SQL } from './historyDecode.js';
import { applyHistoricalLedger, snapshotLedgerBound } from './ledger.js';
import type { LiveLogger } from './live.js';
import type { ClosedLedger } from './source.js';

export const HISTORY_DB_STATUS = 'history_db_status';
export const HISTORY_DB_FROM = 'history_db_from';
export const HISTORY_DB_THROUGH = 'history_db_through';
export const HISTORY_DB_NEXT = 'history_db_next';
export const HISTORY_DB_LEDGER = 'history_db_ledger';

export interface HistoryDbRange {
  from: number;
  through: number;
}

export interface HistoryDbImportResult {
  skipped: boolean;
  from: number | null;
  through: number | null;
  applied: number;
  decoded: number;
  failed: number;
}

interface LedgerHeaderRow {
  LedgerSeq: number;
  LedgerHash: string;
  ClosingTime: number;
}

interface TransactionRow {
  LedgerSeq: number;
  TransID: string;
  TransType: string;
  RawTxn: unknown;
  TxnMeta: unknown;
}

function parseStateInt(db: SqliteDatabase, key: string): number | null {
  const raw = getIndexerState(db, key);
  if (raw === undefined || raw === '') {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function unixSecondsFromRipple(rippleTime: number): number {
  return Math.floor(rippleTimeToUnixTime(rippleTime) / 1000);
}

function openHistoryFile(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  return db;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as
    | { ok: number }
    | undefined;
  return row !== undefined;
}

function dumpBounds(ledgerDb: Database.Database, txDb: Database.Database): HistoryDbRange | null {
  const ledgers = ledgerDb.prepare('SELECT MIN(LedgerSeq) AS lo, MAX(LedgerSeq) AS hi FROM Ledgers').get() as {
    lo: number | null;
    hi: number | null;
  };
  const txs = txDb.prepare('SELECT MIN(LedgerSeq) AS lo, MAX(LedgerSeq) AS hi FROM Transactions').get() as {
    lo: number | null;
    hi: number | null;
  };
  const lows = [ledgers.lo, txs.lo].filter((value): value is number => value !== null && Number.isInteger(value));
  const highs = [ledgers.hi, txs.hi].filter((value): value is number => value !== null && Number.isInteger(value));
  if (lows.length === 0 || highs.length === 0) {
    return null;
  }
  const from = Math.min(...lows);
  const through = Math.max(...highs);
  if (from < 1 || through < from) {
    return null;
  }
  return { from, through };
}

export function historyImportedRange(db: SqliteDatabase): HistoryDbRange | null {
  if (getIndexerState(db, HISTORY_DB_STATUS) !== 'complete') {
    return null;
  }
  const from = parseStateInt(db, HISTORY_DB_FROM);
  const through = parseStateInt(db, HISTORY_DB_THROUGH);
  if (from === null || through === null || through < from) {
    return null;
  }
  return { from, through };
}

export function historyImportTargetRange(
  dump: HistoryDbRange,
  snapshotLedger: number,
  fromBound: number | null,
): HistoryDbRange | null {
  if (snapshotLedger < 1) {
    return null;
  }
  const from = Math.max(dump.from, fromBound ?? dump.from, 1);
  const through = Math.min(dump.through, snapshotLedger);
  if (through < from) {
    return null;
  }
  return { from, through };
}

function resumeNext(storedNext: number | null, target: HistoryDbRange, storedThrough: number | null): number {
  if (storedNext !== null && storedNext >= target.from && storedNext <= target.through + 1) {
    return storedNext;
  }
  if (storedThrough !== null && storedThrough >= target.from && storedThrough < target.through) {
    return storedThrough + 1;
  }
  return target.from;
}

export async function runHistoryDbImport(options: {
  db: SqliteDatabase;
  config: Config;
  log: LiveLogger;
  signal?: AbortSignal;
}): Promise<HistoryDbImportResult> {
  const empty: HistoryDbImportResult = {
    skipped: true,
    from: null,
    through: null,
    applied: 0,
    decoded: 0,
    failed: 0,
  };
  if (!options.config.historyFromDb) {
    return empty;
  }
  const ledgerPath = options.config.historyLedgerDb;
  const txPath = options.config.historyTxDb;
  if (ledgerPath === null || txPath === null) {
    throw new Error('HISTORY_LEDGER_DB and HISTORY_TX_DB are required when BACKFILL_FROM_DB is set');
  }
  if (!existsSync(ledgerPath) || !existsSync(txPath)) {
    throw new Error(`history database files not found: ${ledgerPath} / ${txPath}`);
  }
  const snapshot = snapshotLedgerBound(options.db);
  if (snapshot < 1) {
    options.log.warn({ snapshot }, 'history DB import skipped; snapshot is not complete');
    return empty;
  }

  let ledgerDb: Database.Database | undefined;
  let txDb: Database.Database | undefined;
  try {
    ledgerDb = openHistoryFile(ledgerPath);
    txDb = openHistoryFile(txPath);
    if (!tableExists(ledgerDb, 'Ledgers') || !tableExists(txDb, 'Transactions')) {
      throw new Error('history files are missing Ledgers or Transactions tables');
    }
    const dump = dumpBounds(ledgerDb, txDb);
    if (dump === null) {
      options.log.warn({ ledgerPath, txPath }, 'history DB import skipped; dump is empty');
      return empty;
    }
    const target = historyImportTargetRange(dump, snapshot, resolveBackfillFrom(options.config, snapshot));
    if (target === null) {
      options.log.info(
        { dumpFrom: dump.from, dumpThrough: dump.through, snapshot },
        'history DB import skipped; dump is entirely above the snapshot',
      );
      return empty;
    }

    const storedStatus = getIndexerState(options.db, HISTORY_DB_STATUS);
    const storedFrom = parseStateInt(options.db, HISTORY_DB_FROM);
    const storedThrough = parseStateInt(options.db, HISTORY_DB_THROUGH);
    const storedNext = parseStateInt(options.db, HISTORY_DB_NEXT);
    if (
      storedStatus === 'complete' &&
      storedFrom === target.from &&
      storedThrough === target.through
    ) {
      return { skipped: true, from: target.from, through: target.through, applied: 0, decoded: 0, failed: 0 };
    }

    let next = resumeNext(storedNext, target, storedThrough);
    setIndexerState(options.db, HISTORY_DB_FROM, String(target.from));
    setIndexerState(options.db, HISTORY_DB_THROUGH, String(target.through));
    setIndexerState(options.db, HISTORY_DB_NEXT, String(next));
    setIndexerState(options.db, HISTORY_DB_STATUS, 'running');
    options.log.info(
      {
        from: target.from,
        through: target.through,
        next,
        dumpFrom: dump.from,
        dumpThrough: dump.through,
        batchSize: options.config.historyBatchSize,
        workers: options.config.historyWorkers,
        ledgerPath,
        txPath,
      },
      'history DB import starting',
    );

    const headerStmt = ledgerDb.prepare(
      `
      SELECT LedgerSeq, LedgerHash, ClosingTime
      FROM Ledgers
      WHERE LedgerSeq >= ? AND LedgerSeq <= ?
      ORDER BY LedgerSeq
      `,
    );
    const txStmt = txDb.prepare(
      `
      SELECT LedgerSeq, TransID, TransType, RawTxn, TxnMeta
      FROM Transactions
      WHERE Status = 'V'
        AND LedgerSeq >= ?
        AND LedgerSeq <= ?
        AND TransType IN (${HISTORY_TX_TYPE_SQL})
      ORDER BY LedgerSeq, TransID
      `,
    );

    let applied = 0;
    let decoded = 0;
    let failed = 0;
    const batchSize = options.config.historyBatchSize;
    while (next <= target.through) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('aborted');
      }
      const batchThrough = Math.min(target.through, next + batchSize - 1);
      const headers = headerStmt.all(next, batchThrough) as LedgerHeaderRow[];
      const headerBySeq = new Map<number, LedgerHeaderRow>();
      for (const header of headers) {
        headerBySeq.set(Number(header.LedgerSeq), header);
      }
      const rows = txStmt.all(next, batchThrough) as TransactionRow[];
      const jobs = rows.map((row) => ({
        transId: String(row.TransID),
        rawTxn: row.RawTxn,
        txnMeta: row.TxnMeta,
      }));
      const decodedTxs = await decodeHistoryTransactions(
        jobs,
        options.config.historyWorkers,
        options.signal,
      );
      const txsByLedger = new Map<number, unknown[]>();
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const tx = decodedTxs[index];
        if (row === undefined) {
          continue;
        }
        if (tx === null || tx === undefined) {
          failed += 1;
          options.log.warn(
            { ledger: Number(row.LedgerSeq), tx: row.TransID, type: row.TransType },
            'history DB tx decode failed',
          );
          continue;
        }
        decoded += 1;
        const seq = Number(row.LedgerSeq);
        const list = txsByLedger.get(seq) ?? [];
        list.push(tx);
        txsByLedger.set(seq, list);
      }
      for (let seq = next; seq <= batchThrough; seq += 1) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? new Error('aborted');
        }
        const header = headerBySeq.get(seq);
        if (header === undefined) {
          continue;
        }
        const ledger: ClosedLedger = {
          index: seq,
          hash: String(header.LedgerHash ?? ''),
          closeTime: unixSecondsFromRipple(Number(header.ClosingTime ?? 0)),
          transactions: txsByLedger.get(seq) ?? [],
        };
        const result = applyHistoricalLedger(options.db, ledger, options.log);
        applied += result.applied ? 1 : 0;
        setIndexerState(options.db, HISTORY_DB_LEDGER, String(seq));
      }
      next = batchThrough + 1;
      setIndexerState(options.db, HISTORY_DB_NEXT, String(next));
      options.log.info(
        {
          from: target.from,
          through: target.through,
          next,
          applied,
          decoded,
          failed,
        },
        'history DB import progress',
      );
    }
    setIndexerState(options.db, HISTORY_DB_STATUS, 'complete');
    options.log.info(
      { from: target.from, through: target.through, applied, decoded, failed },
      'history DB import complete',
    );
    return { skipped: false, from: target.from, through: target.through, applied, decoded, failed };
  } finally {
    ledgerDb?.close();
    txDb?.close();
  }
}
