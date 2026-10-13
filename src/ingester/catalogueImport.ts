import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { resolveBackfillFrom, type Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, hasLedger, setIndexerState } from '../db/queries/indexer.js';
import {
  CatalogueError,
  XAHAU_MAINNET_ID,
  decodeCatalogueTransactions,
  iterateCatalogueLedgers,
  listCatalogueFiles,
  type CatalogueCheckpoint,
  type CatalogueFile,
} from './catalogue.js';
import { zlibRandomAccessAvailable } from './zlibInflate.js';
import {
  HISTORY_DB_FROM,
  HISTORY_DB_LEDGER,
  HISTORY_DB_NEXT,
  HISTORY_DB_STATUS,
  HISTORY_DB_THROUGH,
  historyImportTargetRange,
  historyImportedRange,
  type HistoryDbImportResult,
} from './historyDb.js';
import { applyHistoricalLedger, snapshotLedgerBound } from './ledger.js';
import type { LiveLogger } from './live.js';

export const HISTORY_CATALOGUE_PATH = 'history_catalogue_path';
export const HISTORY_CATALOGUE_CKPT = 'history_catalogue_ckpt';
export const CATALOGUE_CHECKPOINT_EVERY = 1000;
export const CATALOGUE_SKIP_CHECKPOINT_EVERY = 50_000;

function parseStateInt(db: SqliteDatabase, key: string): number | null {
  const raw = getIndexerState(db, key);
  if (raw === undefined || raw === '') {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function resumeNext(storedNext: number | null, target: { from: number; through: number }): number {
  if (storedNext !== null && storedNext >= target.from && storedNext <= target.through + 1) {
    return storedNext;
  }
  return target.from;
}

function targetContained(db: SqliteDatabase, target: { from: number; through: number }): boolean {
  const imported = historyImportedRange(db);
  return imported !== null && target.from >= imported.from && target.through <= imported.through;
}

interface StoredCheckpoint {
  path: string;
  nextSeq: number;
  prevAccountHash: string | null;
  pending: string;
  inputOffset: number;
  bits: number;
  window: string | null;
}

function loadCheckpoint(db: SqliteDatabase, path: string, cursor: number): CatalogueCheckpoint | undefined {
  const raw = getIndexerState(db, HISTORY_CATALOGUE_CKPT);
  if (raw === undefined || raw === '') {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as StoredCheckpoint;
    if (
      parsed.path !== path ||
      !Number.isInteger(parsed.nextSeq) ||
      parsed.nextSeq < 1 ||
      parsed.nextSeq > cursor ||
      !Number.isInteger(parsed.inputOffset) ||
      parsed.inputOffset < 0
    ) {
      return undefined;
    }
    return {
      path: parsed.path,
      nextSeq: parsed.nextSeq,
      prevAccountHash: parsed.prevAccountHash,
      pending: Buffer.from(parsed.pending, 'base64'),
      inputOffset: parsed.inputOffset,
      bits: parsed.bits,
      window: parsed.window === null || parsed.window === undefined ? null : Buffer.from(parsed.window, 'base64'),
    };
  } catch {
    return undefined;
  }
}

function saveCheckpoint(db: SqliteDatabase, checkpoint: CatalogueCheckpoint): void {
  const stored: StoredCheckpoint = {
    path: checkpoint.path,
    nextSeq: checkpoint.nextSeq,
    prevAccountHash: checkpoint.prevAccountHash,
    pending: checkpoint.pending.toString('base64'),
    inputOffset: checkpoint.inputOffset,
    bits: checkpoint.bits,
    window: checkpoint.window === null ? null : checkpoint.window.toString('base64'),
  };
  setIndexerState(db, HISTORY_CATALOGUE_CKPT, JSON.stringify(stored));
}

function checkpointUsable(file: CatalogueFile, resume: CatalogueCheckpoint | undefined): resume is CatalogueCheckpoint {
  if (resume === undefined) {
    return false;
  }
  if (resume.nextSeq > file.header.minLedger && resume.prevAccountHash === null) {
    return false;
  }
  if (file.header.compressionLevel === 0) {
    return true;
  }
  return resume.window !== null && zlibRandomAccessAvailable();
}

async function importCatalogueFile(options: {
  db: SqliteDatabase;
  log: LiveLogger;
  signal?: AbortSignal;
  file: CatalogueFile;
  snapshot: number;
  config: Config;
}): Promise<{ applied: number; decoded: number; skipped: boolean; from: number; through: number }> {
  const { db, log, file } = options;
  const target = historyImportTargetRange(
    { from: Math.max(1, file.header.minLedger), through: file.header.maxLedger },
    options.snapshot,
    resolveBackfillFrom(options.config, options.snapshot),
  );
  if (target === null) {
    log.info(
      { path: file.path, dumpFrom: file.header.minLedger, dumpThrough: file.header.maxLedger, snapshot: options.snapshot },
      'catalogue import skipped; file is entirely above the snapshot',
    );
    const storedFrom = parseStateInt(db, HISTORY_DB_FROM);
    const storedThrough = parseStateInt(db, HISTORY_DB_THROUGH);
    return {
      applied: 0,
      decoded: 0,
      skipped: true,
      from: storedFrom ?? file.header.minLedger,
      through: storedThrough ?? file.header.maxLedger,
    };
  }
  if (targetContained(db, target)) {
    const imported = historyImportedRange(db);
    log.info(
      { path: file.path, from: target.from, through: target.through },
      'catalogue file skipped; already imported',
    );
    return {
      applied: 0,
      decoded: 0,
      skipped: true,
      from: imported?.from ?? target.from,
      through: imported?.through ?? target.through,
    };
  }

  const storedFrom = parseStateInt(db, HISTORY_DB_FROM);
  const storedThrough = parseStateInt(db, HISTORY_DB_THROUGH);
  const storedNext = parseStateInt(db, HISTORY_DB_NEXT);
  const overallFrom = storedFrom !== null ? Math.min(storedFrom, target.from) : target.from;
  const overallThrough = storedThrough !== null ? Math.max(storedThrough, target.through) : target.through;
  const next = resumeNext(storedNext, target);
  setIndexerState(db, HISTORY_DB_FROM, String(overallFrom));
  setIndexerState(db, HISTORY_DB_THROUGH, String(overallThrough));
  setIndexerState(db, HISTORY_DB_NEXT, String(next));
  setIndexerState(db, HISTORY_DB_STATUS, 'running');
  if (file.header.networkId !== 0 && file.header.networkId !== XAHAU_MAINNET_ID) {
    log.warn({ networkId: file.header.networkId, expected: XAHAU_MAINNET_ID }, 'catalogue network_id is not Xahau mainnet');
  }
  const loaded = loadCheckpoint(db, file.path, next);
  const resume = checkpointUsable(file, loaded) ? loaded : undefined;
  log.info(
    {
      path: file.path,
      from: target.from,
      through: overallThrough,
      next,
      dumpFrom: file.header.minLedger,
      dumpThrough: file.header.maxLedger,
      networkId: file.header.networkId,
      compressionLevel: file.header.compressionLevel,
      ...(resume === undefined ? {} : { resumeSeq: resume.nextSeq, resumeOffset: resume.inputOffset }),
    },
    resume === undefined ? 'catalogue import starting' : 'catalogue import resuming from checkpoint',
  );

  let applied = 0;
  let decoded = 0;
  let cursor = next;
  let seen = 0;
  let scanned = 0;
  const runIterate = async (useResume: CatalogueCheckpoint | undefined): Promise<void> => {
    const iterateOpts = {
      decodeFrom: cursor,
      skipUntil: Math.max(target.from, cursor),
      skipCheckpointEvery: CATALOGUE_SKIP_CHECKPOINT_EVERY,
      onSkipProgress: async (info: { seq: number; scanned: number; checkpoint: () => Promise<CatalogueCheckpoint> }) => {
        saveCheckpoint(db, await info.checkpoint());
        log.info(
          { path: file.path, seq: info.seq, next: cursor, scanned: info.scanned },
          'catalogue import scanning to resume point',
        );
      },
      ...(useResume === undefined ? {} : { resume: useResume }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    for await (const item of iterateCatalogueLedgers(file.path, iterateOpts)) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('aborted');
      }
      const seq = item.ledger.index;
      scanned += 1;
      if (scanned % 100 === 0) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
      if (seq > target.through) {
        break;
      }
      seen += 1;
      if (hasLedger(db, seq)) {
        cursor = seq + 1;
        setIndexerState(db, HISTORY_DB_LEDGER, String(seq));
        setIndexerState(db, HISTORY_DB_NEXT, String(cursor));
      } else {
        const transactions = decodeCatalogueTransactions(item.ledger.blobs);
        decoded += transactions.length;
        const result = applyHistoricalLedger(
          db,
          {
            index: seq,
            hash: item.ledger.hash,
            closeTime: item.ledger.closeTime,
            transactions,
          },
          log,
        );
        applied += result.applied ? 1 : 0;
        cursor = seq + 1;
        setIndexerState(db, HISTORY_DB_LEDGER, String(seq));
        setIndexerState(db, HISTORY_DB_NEXT, String(cursor));
      }
      if (seq % CATALOGUE_CHECKPOINT_EVERY === 0) {
        saveCheckpoint(db, await item.checkpoint());
      }
      if (seen === 1 || seq % 100 === 0) {
        log.info(
          { from: overallFrom, through: overallThrough, next: cursor, applied, decoded },
          'catalogue import progress',
        );
      }
    }
  };

  try {
    await runIterate(resume);
  } catch (error) {
    if (
      resume !== undefined &&
      error instanceof CatalogueError &&
      error.message.startsWith('unexpected end of catalogue')
    ) {
      log.warn(
        { path: file.path, resumeSeq: resume.nextSeq, err: error.message },
        'catalogue checkpoint missed the payload; restarting this file from the beginning',
      );
      setIndexerState(db, HISTORY_CATALOGUE_CKPT, '');
      await runIterate(undefined);
    } else {
      throw error;
    }
  }
  return { applied, decoded, skipped: false, from: overallFrom, through: overallThrough };
}

export async function runCatalogueImport(options: {
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
  const path = options.config.historyCatalogue;
  if (path === null) {
    return empty;
  }
  if (!existsSync(path)) {
    throw new Error(`HISTORY_CATALOGUE path not found: ${path}`);
  }
  const snapshot = snapshotLedgerBound(options.db);
  if (snapshot < 1) {
    options.log.warn({ snapshot }, 'catalogue import skipped; snapshot is not complete');
    return empty;
  }

  const resolved = resolvePath(path);
  const files = await listCatalogueFiles(resolved);
  setIndexerState(options.db, HISTORY_CATALOGUE_PATH, resolved);
  if (files.length > 1 || files[0]?.path !== resolved) {
    options.log.info(
      {
        path: resolved,
        files: files.map((file) => ({
          path: file.path,
          from: file.header.minLedger,
          through: file.header.maxLedger,
        })),
      },
      'catalogue import directory',
    );
  }

  let applied = 0;
  let decoded = 0;
  const failed = 0;
  let importedAny = false;
  let from: number | null = null;
  let through: number | null = null;
  for (const file of files) {
    const result = await importCatalogueFile({
      db: options.db,
      log: options.log,
      file,
      snapshot,
      config: options.config,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    applied += result.applied;
    decoded += result.decoded;
    from = from === null ? result.from : Math.min(from, result.from);
    through = through === null ? result.through : Math.max(through, result.through);
    if (!result.skipped) {
      importedAny = true;
    }
  }
  if (!importedAny) {
    const imported = historyImportedRange(options.db);
    return {
      skipped: true,
      from: imported?.from ?? from,
      through: imported?.through ?? through,
      applied: 0,
      decoded: 0,
      failed: 0,
    };
  }
  setIndexerState(options.db, HISTORY_DB_STATUS, 'complete');
  setIndexerState(options.db, HISTORY_CATALOGUE_CKPT, '');
  options.log.info(
    { from, through, applied, decoded, failed, path: resolved, files: files.length },
    'catalogue import complete',
  );
  return { skipped: false, from, through, applied, decoded, failed };
}
