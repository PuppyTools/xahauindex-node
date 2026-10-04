import { resolveBackfillFrom, type Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, setIndexerState } from '../db/queries/indexer.js';
import { withQuota } from '../util/quota.js';
import { retry, sleep } from '../util/retry.js';
import { applyHistoricalLedger } from './ledger.js';
import type { LiveLogger } from './live.js';
import type { ClosedLedger, LiveLedgerSource } from './source.js';

export type BackfillRunStatus = 'idle' | 'running' | 'complete';

export const BACKFILL_DIRECTION = 'backward';

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

/**
 * Next ledger to fetch while walking snapshot → FROM.
 * Forward-era progress (no `backfill_direction`) restarts at the snapshot so
 * recent history is filled first. A completed narrower range continues downward
 * from the previous `FROM` without re-walking the high end.
 */
export function backfillProgress(from: number, through: number, next: number): {
  from: number;
  through: number;
  next: number;
  remaining: number;
  done: number;
  pct: number;
  direction: typeof BACKFILL_DIRECTION;
} {
  const total = Math.max(0, through - from + 1);
  const remaining = next < from ? 0 : Math.max(0, next - from + 1);
  const done = Math.max(0, total - remaining);
  const pct = total === 0 ? 100 : Math.floor((done / total) * 100);
  return { from, through, next, remaining, done, pct, direction: BACKFILL_DIRECTION };
}

export function resumeBackfillIndex(options: {
  from: number;
  through: number;
  storedFrom: number | null;
  storedNext: number | null;
  storedStatus: string | undefined;
  storedDirection: string | undefined;
}): number {
  const { from, through, storedFrom, storedNext, storedStatus, storedDirection } = options;
  if (storedDirection === BACKFILL_DIRECTION) {
    if (storedNext === null) {
      return through;
    }
    if (storedNext > through) {
      return through;
    }
    return storedNext;
  }
  if (storedStatus === 'complete' && storedFrom !== null && storedFrom > from) {
    return storedFrom - 1;
  }
  return through;
}

export async function runBackfill(options: {
  db: SqliteDatabase;
  source: Pick<LiveLedgerSource, 'getLedgerWithTransactions' | 'quota'>;
  config: Config;
  log: LiveLogger;
  signal?: AbortSignal;
  fetchAttempts?: number;
  retryMinMs?: number;
  minIntervalMs?: number;
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
  const storedDirection = getIndexerState(db, 'backfill_direction');
  if (
    storedStatus === 'complete' &&
    storedFrom !== null &&
    storedFrom <= from &&
    (parseStateInt(db, 'backfill_through') ?? 0) >= through
  ) {
    return { skipped: true, from: storedFrom, through, applied: 0, skippedLedgers: 0 };
  }

  let index = resumeBackfillIndex({
    from,
    through,
    storedFrom,
    storedNext,
    storedStatus,
    storedDirection,
  });
  setIndexerState(db, 'backfill_from', String(from));
  setIndexerState(db, 'backfill_through', String(through));
  setIndexerState(db, 'backfill_direction', BACKFILL_DIRECTION);
  setIndexerState(db, 'backfill_next', String(index));
  setIndexerState(db, 'backfill_status', 'running');
  const minIntervalMs = options.minIntervalMs ?? 0;
  log.info(
    { ...backfillProgress(from, through, index), minIntervalMs },
    'historical backfill starting (snapshot → FROM)',
  );

  let applied = 0;
  let skippedLedgers = 0;
  const shouldLogProgress = (next: number, force: boolean): boolean =>
    force || next < from || next % 100 === 0;
  const pace = async (): Promise<void> => {
    if (minIntervalMs > 0) {
      await sleep(minIntervalMs, options.signal);
    }
  };
  while (index >= from) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('aborted');
    }
    let ledger: ClosedLedger;
    try {
      ledger = await retry(
        () =>
          withQuota(
            source.quota,
            'backfill',
            () => source.getLedgerWithTransactions(index),
            options.signal,
            ({ reason, waitMs }) => {
              log.info(
                { ...backfillProgress(from, through, index), reason, waitMs },
                'historical backfill paused for live quota',
              );
            },
          ),
        {
          minMs: options.retryMinMs ?? 1_000,
          maxMs: 30_000,
          attempts: options.fetchAttempts ?? 6,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onRetry: ({ waitMs, rateLimited }) => {
            if (rateLimited) {
              log.warn({ ledger: index, waitMs }, 'historical backfill rate-limited, waiting');
            }
          },
        },
      );
    } catch (error) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? error;
      }
      log.warn({ err: error, ledger: index }, 'historical ledger unavailable, skipping');
      skippedLedgers += 1;
      index -= 1;
      setIndexerState(db, 'backfill_next', String(index));
      if (shouldLogProgress(index, false)) {
        log.info(
          { ...backfillProgress(from, through, index), skippedLedgers },
          'historical backfill progress',
        );
      }
      await pace();
      continue;
    }

    const result = applyHistoricalLedger(db, ledger, log);
    applied += result.applied ? 1 : 0;
    setIndexerState(db, 'backfill_ledger', String(result.index));
    index -= 1;
    setIndexerState(db, 'backfill_next', String(index));
    if (shouldLogProgress(index, applied === 1)) {
      log.info(
        {
          ...backfillProgress(from, through, index),
          ledger: result.index,
          txApplied: result.txApplied,
          trades: result.trades.length,
          skippedLedgers,
        },
        'historical backfill progress',
      );
    }
    await pace();
  }

  setIndexerState(db, 'backfill_status', 'complete');
  log.info(
    { ...backfillProgress(from, through, from - 1), applied, skippedLedgers },
    'historical backfill complete',
  );
  return { skipped: false, from, through, applied, skippedLedgers };
}
