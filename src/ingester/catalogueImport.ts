import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { resolveBackfillFrom, type Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, hasLedger, setIndexerState } from '../db/queries/indexer.js';
import { XAHAU_MAINNET_ID, decodeCatalogueTransactions, iterateCatalogueLedgers, readCatalogueHeader } from './catalogue.js';
import {
  HISTORY_DB_FROM,
  HISTORY_DB_LEDGER,
  HISTORY_DB_NEXT,
  HISTORY_DB_STATUS,
  HISTORY_DB_THROUGH,
  historyImportTargetRange,
  type HistoryDbImportResult,
} from './historyDb.js';
import { applyHistoricalLedger, snapshotLedgerBound } from './ledger.js';
import type { LiveLogger } from './live.js';

export const HISTORY_CATALOGUE_PATH = 'history_catalogue_path';

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
    throw new Error(`HISTORY_CATALOGUE file not found: ${path}`);
  }
  const snapshot = snapshotLedgerBound(options.db);
  if (snapshot < 1) {
    options.log.warn({ snapshot }, 'catalogue import skipped; snapshot is not complete');
    return empty;
  }

  const resolved = resolvePath(path);
  const header = await readCatalogueHeader(resolved);
  const target = historyImportTargetRange(
    { from: Math.max(1, header.minLedger), through: header.maxLedger },
    snapshot,
    resolveBackfillFrom(options.config, snapshot),
  );
  if (target === null) {
    options.log.info(
      { dumpFrom: header.minLedger, dumpThrough: header.maxLedger, snapshot },
      'catalogue import skipped; file is entirely above the snapshot',
    );
    return empty;
  }

  const storedStatus = getIndexerState(options.db, HISTORY_DB_STATUS);
  const storedFrom = parseStateInt(options.db, HISTORY_DB_FROM);
  const storedThrough = parseStateInt(options.db, HISTORY_DB_THROUGH);
  const storedNext = parseStateInt(options.db, HISTORY_DB_NEXT);
  if (
    storedStatus === 'complete' &&
    storedFrom !== null &&
    storedThrough !== null &&
    target.from >= storedFrom &&
    target.through <= storedThrough
  ) {
    return { skipped: true, from: storedFrom, through: storedThrough, applied: 0, decoded: 0, failed: 0 };
  }

  const overallFrom = storedFrom !== null ? Math.min(storedFrom, target.from) : target.from;
  const overallThrough = storedThrough !== null ? Math.max(storedThrough, target.through) : target.through;
  const next = resumeNext(storedNext, target);
  setIndexerState(options.db, HISTORY_DB_FROM, String(overallFrom));
  setIndexerState(options.db, HISTORY_DB_THROUGH, String(overallThrough));
  setIndexerState(options.db, HISTORY_DB_NEXT, String(next));
  setIndexerState(options.db, HISTORY_DB_STATUS, 'running');
  setIndexerState(options.db, HISTORY_CATALOGUE_PATH, resolved);
  if (header.networkId !== 0 && header.networkId !== XAHAU_MAINNET_ID) {
    options.log.warn({ networkId: header.networkId, expected: XAHAU_MAINNET_ID }, 'catalogue network_id is not Xahau mainnet');
  }
  options.log.info(
    {
      path: resolved,
      from: target.from,
      through: overallThrough,
      next,
      dumpFrom: header.minLedger,
      dumpThrough: header.maxLedger,
      networkId: header.networkId,
      compressionLevel: header.compressionLevel,
    },
    'catalogue import starting',
  );

  let applied = 0;
  let decoded = 0;
  const failed = 0;
  let cursor = next;
  let seen = 0;
  let scanned = 0;
  for await (const item of iterateCatalogueLedgers(resolved, options.signal === undefined ? {} : { signal: options.signal })) {
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
    if (seq < target.from || seq < cursor) {
      continue;
    }
    if (seq > target.through) {
      break;
    }
    seen += 1;
    if (hasLedger(options.db, seq)) {
      cursor = seq + 1;
      setIndexerState(options.db, HISTORY_DB_LEDGER, String(seq));
      setIndexerState(options.db, HISTORY_DB_NEXT, String(cursor));
    } else {
      const transactions = decodeCatalogueTransactions(item.ledger.blobs);
      decoded += transactions.length;
      const result = applyHistoricalLedger(
        options.db,
        {
          index: seq,
          hash: item.ledger.hash,
          closeTime: item.ledger.closeTime,
          transactions,
        },
        options.log,
      );
      applied += result.applied ? 1 : 0;
      cursor = seq + 1;
      setIndexerState(options.db, HISTORY_DB_LEDGER, String(seq));
      setIndexerState(options.db, HISTORY_DB_NEXT, String(cursor));
    }
    if (seen === 1 || seq % 100 === 0) {
      options.log.info(
        { from: overallFrom, through: overallThrough, next: cursor, applied, decoded },
        'catalogue import progress',
      );
    }
  }
  setIndexerState(options.db, HISTORY_DB_STATUS, 'complete');
  options.log.info(
    { from: overallFrom, through: overallThrough, applied, decoded, failed, path: resolved },
    'catalogue import complete',
  );
  return { skipped: false, from: overallFrom, through: overallThrough, applied, decoded, failed };
}
