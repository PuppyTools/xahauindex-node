import { resolveBackfillFrom, type Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, setIndexerState } from '../db/queries/indexer.js';
import { withQuota } from '../util/quota.js';
import { retry, sleep } from '../util/retry.js';
import { applyClosedLedger, applyHistoricalLedger } from './ledger.js';
import { historyImportedRange } from './historyDb.js';
import {
  LIVE_GAP_NEXT,
  readLiveGap,
  type LiveLogger,
} from './live.js';
import { walkPrefetch } from './prefetch.js';
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

function fetchClosedLedger(
  source: Pick<LiveLedgerSource, 'getLedgerWithTransactions' | 'quota'>,
  index: number,
  options: {
    log: LiveLogger;
    signal?: AbortSignal;
    fetchAttempts?: number;
    retryMinMs?: number;
    pauseMsg: string;
    retryMsg: string;
    rateLimitMsg: string;
    progress?: Record<string, unknown>;
  },
): Promise<ClosedLedger> {
  return retry(
    () =>
      withQuota(
        source.quota,
        'backfill',
        () => source.getLedgerWithTransactions(index),
        options.signal,
        ({ reason, waitMs }) => {
          options.log.info({ ledger: index, reason, waitMs, ...options.progress }, options.pauseMsg);
        },
      ),
    {
      minMs: options.retryMinMs ?? 1_000,
      maxMs: 30_000,
      attempts: options.fetchAttempts ?? 6,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onRetry: ({ waitMs, rateLimited, error }) => {
        if (rateLimited) {
          options.log.warn(
            {
              ledger: index,
              waitMs,
              ...(source.quota?.restricted ? { concurrentLimit: source.quota.concurrentLimit } : {}),
            },
            options.rateLimitMsg,
          );
          return;
        }
        options.log.warn({ ledger: index, waitMs, err: error }, options.retryMsg);
      },
    },
  );
}

export async function fillLiveGap(options: {
  db: SqliteDatabase;
  source: Pick<LiveLedgerSource, 'getLedgerWithTransactions' | 'quota'>;
  log: LiveLogger;
  signal?: AbortSignal;
  fetchAttempts?: number;
  retryMinMs?: number;
  minIntervalMs?: number;
  concurrency?: number;
}): Promise<{ skipped: boolean; from: number | null; through: number | null; applied: number; skippedLedgers: number }> {
  const { db, source, log } = options;
  const gap = readLiveGap(db);
  if (gap === null) {
    return { skipped: true, from: null, through: null, applied: 0, skippedLedgers: 0 };
  }
  const minIntervalMs = options.minIntervalMs ?? 0;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  log.info(
    { from: gap.from, through: gap.through, next: gap.next, minIntervalMs, concurrency },
    'live gap fill starting (last indexed → subscribe tip)',
  );
  let applied = 0;
  let skippedLedgers = 0;
  await walkPrefetch({
    start: gap.next,
    step: 1,
    concurrency,
    launchDelayMs: minIntervalMs,
    inRange: (index) => {
      const current = readLiveGap(db);
      if (current === null) {
        return false;
      }
      gap.through = current.through;
      return index <= current.through;
    },
    fetch: (index) =>
      fetchClosedLedger(source, index, {
        log,
        pauseMsg: 'live gap fill paused for quota',
        retryMsg: 'live gap fill retrying',
        rateLimitMsg: 'live gap fill rate-limited, waiting',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.fetchAttempts === undefined ? {} : { fetchAttempts: options.fetchAttempts }),
        ...(options.retryMinMs === undefined ? {} : { retryMinMs: options.retryMinMs }),
      }),
    visit: (index, outcome) => {
      if (!outcome.ok) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? outcome.error;
        }
        log.warn({ err: outcome.error, ledger: index }, 'live gap ledger unavailable, skipping');
        skippedLedgers += 1;
        setIndexerState(db, LIVE_GAP_NEXT, String(index + 1));
        return;
      }
      const result = applyClosedLedger(db, outcome.value, log);
      applied += result.applied ? 1 : 0;
      setIndexerState(db, LIVE_GAP_NEXT, String(index + 1));
      if (result.applied || (index + 1) % 100 === 0 || index + 1 > gap.through) {
        log.info(
          {
            from: gap.from,
            through: gap.through,
            next: index + 1,
            ledger: result.index,
            applied,
            skippedLedgers,
          },
          'live gap fill progress',
        );
      }
    },
    afterVisit: async () => {
      if (minIntervalMs > 0) {
        await sleep(minIntervalMs, options.signal);
      }
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  log.info(
    { from: gap.from, through: gap.through, applied, skippedLedgers },
    'live gap fill complete',
  );
  return { skipped: false, from: gap.from, through: gap.through, applied, skippedLedgers };
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
  concurrency?: number;
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

  const index = resumeBackfillIndex({
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
  const imported = historyImportedRange(db);
  const minIntervalMs = options.minIntervalMs ?? 0;
  const concurrency = Math.max(1, options.concurrency ?? 1);
  log.info(
    {
      ...backfillProgress(from, through, index),
      minIntervalMs,
      concurrency,
      ...(imported === null ? {} : { historyDbFrom: imported.from, historyDbThrough: imported.through }),
    },
    'historical backfill starting (snapshot → FROM)',
  );

  let applied = 0;
  let skippedLedgers = 0;
  const shouldLogProgress = (next: number, force: boolean): boolean =>
    force || next < from || next % 100 === 0;
  let loggedJump = false;
  await walkPrefetch({
    start: index,
    step: -1,
    concurrency,
    launchDelayMs: minIntervalMs,
    inRange: (cursor) => cursor >= from,
    jump: (cursor) => {
      if (imported !== null && cursor >= imported.from && cursor <= imported.through) {
        return imported.from - 1;
      }
      return null;
    },
    onJump: (_fromIndex, jumpedTo) => {
      setIndexerState(db, 'backfill_next', String(jumpedTo));
      if (!loggedJump && imported !== null) {
        loggedJump = true;
        log.info(
          {
            skippedFrom: imported.from,
            skippedThrough: imported.through,
            next: jumpedTo,
          },
          'RPC backfill jumping history DB import range',
        );
      }
    },
    fetch: (cursor) =>
      fetchClosedLedger(source, cursor, {
        log,
        pauseMsg: 'historical backfill paused for live quota',
        retryMsg: 'historical backfill retrying',
        rateLimitMsg: 'historical backfill rate-limited, waiting',
        progress: backfillProgress(from, through, cursor),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        ...(options.fetchAttempts === undefined ? {} : { fetchAttempts: options.fetchAttempts }),
        ...(options.retryMinMs === undefined ? {} : { retryMinMs: options.retryMinMs }),
      }),
    visit: (cursor, outcome) => {
      if (!outcome.ok) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? outcome.error;
        }
        log.warn({ err: outcome.error, ledger: cursor }, 'historical ledger unavailable, skipping');
        skippedLedgers += 1;
        setIndexerState(db, 'backfill_next', String(cursor - 1));
        if (shouldLogProgress(cursor - 1, false)) {
          log.info(
            { ...backfillProgress(from, through, cursor - 1), skippedLedgers },
            'historical backfill progress',
          );
        }
        return;
      }
      const result = applyHistoricalLedger(db, outcome.value, log);
      applied += result.applied ? 1 : 0;
      setIndexerState(db, 'backfill_ledger', String(result.index));
      setIndexerState(db, 'backfill_next', String(cursor - 1));
      if (shouldLogProgress(cursor - 1, applied === 1)) {
        log.info(
          {
            ...backfillProgress(from, through, cursor - 1),
            ledger: result.index,
            txApplied: result.txApplied,
            trades: result.trades.length,
            skippedLedgers,
          },
          'historical backfill progress',
        );
      }
    },
    afterVisit: async () => {
      if (minIntervalMs > 0) {
        await sleep(minIntervalMs, options.signal);
      }
    },
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  setIndexerState(db, 'backfill_status', 'complete');
  log.info(
    { ...backfillProgress(from, through, from - 1), applied, skippedLedgers },
    'historical backfill complete',
  );
  return { skipped: false, from, through, applied, skippedLedgers };
}
