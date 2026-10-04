import { resolveBackfillFrom, type Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, setIndexerState } from '../db/queries/indexer.js';
import { retry } from '../util/retry.js';
import { applyHistoricalLedger } from './ledger.js';
import type { LiveLogger } from './live.js';
import type { ClosedLedger, LiveLedgerSource } from './source.js';

export type BackfillRunStatus = 'idle' | 'running' | 'complete';

export interface BackfillResult {
  skipped: boolean;
  from: number | null;
  through: number | null;
  applied: number;
  skippedLedgers: number;
}

function parseStateInt(db: SqliteDatabase, key: string): number | null {
  const raw = getIndexerState(db, key);
  if (raw === undefined || raw === '') {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function snapshotLedger(db: SqliteDatabase): number | null {
  const status = getIndexerState(db, 'snapshot_status');
  if (status !== 'complete') {
    return null;
  }
  const ledger = parseStateInt(db, 'snapshot_ledger');
  return ledger !== null && ledger >= 1 ? ledger : null;
}

function nextIndex(from: number, storedFrom: number | null, storedNext: number | null): number {
  if (storedFrom !== null && from < storedFrom) {
    return from;
  }
  if (storedNext !== null && storedNext >= from) {
    return storedNext;
  }
  return from;
}

export async function runBackfill(options: {
  db: SqliteDatabase;
  source: Pick<LiveLedgerSource, 'getLedgerWithTransactions'>;
  config: Config;
  log: LiveLogger;
  signal?: AbortSignal;
  fetchAttempts?: number;
  retryMinMs?: number;
}): Promise<BackfillResult> {
  const { db, source, config, log } = options;
  const empty: BackfillResult = {
    skipped: true,
    from: null,
    through: null,
    applied: 0,
    skippedLedgers: 0,
  };
  const through = snapshotLedger(db);
  if (through === null) {
    return empty;
  }
  const from = resolveBackfillFrom(config, through);
  if (from === null) {
    return empty;
  }

  const storedFrom = parseStateInt(db, 'backfill_from');
  const storedNext = parseStateInt(db, 'backfill_next');
  const storedStatus = getIndexerState(db, 'backfill_status');
  if (
    storedStatus === 'complete' &&
    storedFrom !== null &&
    storedFrom <= from &&
    (parseStateInt(db, 'backfill_through') ?? 0) >= through
  ) {
    return { skipped: true, from: storedFrom, through, applied: 0, skippedLedgers: 0 };
  }

  let index = nextIndex(from, storedFrom, storedNext);
  setIndexerState(db, 'backfill_from', String(from));
  setIndexerState(db, 'backfill_through', String(through));
  setIndexerState(db, 'backfill_next', String(index));
  setIndexerState(db, 'backfill_status', 'running');
  log.info({ from, through, next: index }, 'historical backfill starting');

  let applied = 0;
  let skippedLedgers = 0;
  while (index <= through) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('aborted');
    }
    let ledger: ClosedLedger;
    try {
      ledger = await retry(() => source.getLedgerWithTransactions(index), {
        minMs: options.retryMinMs ?? 1_000,
        maxMs: 30_000,
        attempts: options.fetchAttempts ?? 6,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      }
      log.warn({ err: error, ledger: index }, 'historical ledger unavailable, skipping');
      skippedLedgers += 1;
      index += 1;
      setIndexerState(db, 'backfill_next', String(index));
      continue;
    }

    const result = applyHistoricalLedger(db, ledger, log);
    applied += result.applied ? 1 : 0;
    setIndexerState(db, 'backfill_ledger', String(index));
    index += 1;
    setIndexerState(db, 'backfill_next', String(index));
    if (applied === 1 || index > through || index % 100 === 0) {
      log.info(
        { ledger: result.index, next: index, through, txApplied: result.txApplied, trades: result.trades.length },
        'historical ledger applied',
      );
    }
  }

  setIndexerState(db, 'backfill_status', 'complete');
  log.info({ from, through, applied, skippedLedgers }, 'historical backfill complete');
  return { skipped: false, from, through, applied, skippedLedgers };
}
