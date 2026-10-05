import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, getLatestLedgerIndex, setIndexerState } from '../db/queries/indexer.js';
import type { Runtime } from '../runtime.js';
import { withQuota } from '../util/quota.js';
import { retry } from '../util/retry.js';
import { applyClosedLedger, snapshotLedgerBound, type ApplyClosedLedgerResult } from './ledger.js';
import type { ApplyLogger } from './objects.js';
import {
  completeRangeContaining,
  parseCompleteLedgers,
  type ClosedLedger,
  type LiveLedgerSource,
  type ValidatedLedger,
} from './source.js';

export interface LiveLogger extends ApplyLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug?: (obj: Record<string, unknown>, msg: string) => void;
}

export const LIVE_GAP_FROM = 'live_gap_from';
export const LIVE_GAP_THROUGH = 'live_gap_through';
export const LIVE_GAP_NEXT = 'live_gap_next';

export interface LiveGap {
  from: number;
  through: number;
  next: number;
}

function parseStateInt(db: SqliteDatabase, key: string): number | null {
  const raw = getIndexerState(db, key);
  if (raw === undefined || raw === '') {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function nextLedgerToApply(db: SqliteDatabase): number {
  const latest = getLatestLedgerIndex(db);
  const liveFromRaw = getIndexerState(db, 'live_from_ledger');
  const liveFrom = liveFromRaw === undefined ? 0 : Number.parseInt(liveFromRaw, 10);
  const snapshot = snapshotLedgerBound(db);
  const candidate = Math.max(latest + 1, Number.isInteger(liveFrom) ? liveFrom : 0);
  return candidate <= snapshot ? snapshot + 1 : candidate;
}

export function readLiveGap(db: SqliteDatabase): LiveGap | null {
  const from = parseStateInt(db, LIVE_GAP_FROM);
  const through = parseStateInt(db, LIVE_GAP_THROUGH);
  if (from === null || through === null || from > through) {
    return null;
  }
  const storedNext = parseStateInt(db, LIVE_GAP_NEXT);
  const next = storedNext === null ? from : storedNext;
  if (next > through) {
    return null;
  }
  return { from, through, next };
}

export function recordLiveSubscribeGap(
  db: SqliteDatabase,
  tipIndex: number,
  liveCompleteFrom?: number | null,
): LiveGap | null {
  const sequential = nextLedgerToApply(db);
  const liveFrom =
    liveCompleteFrom !== null &&
    liveCompleteFrom !== undefined &&
    liveCompleteFrom <= tipIndex &&
    liveCompleteFrom > 0
      ? liveCompleteFrom
      : tipIndex;
  const existing = readLiveGap(db);
  if (existing) {
    if (sequential <= existing.through && liveFrom - 1 > existing.through) {
      setIndexerState(db, LIVE_GAP_THROUGH, String(liveFrom - 1));
      return { ...existing, through: liveFrom - 1 };
    }
    return existing;
  }
  const from = sequential;
  const through = liveFrom - 1;
  if (from > through) {
    return null;
  }
  setIndexerState(db, LIVE_GAP_FROM, String(from));
  setIndexerState(db, LIVE_GAP_THROUGH, String(through));
  setIndexerState(db, LIVE_GAP_NEXT, String(from));
  return { from, through, next: from };
}

export function liveCatchUpFloor(
  db: SqliteDatabase,
  tipIndex: number,
  liveCompleteFrom?: number | null,
): number {
  const sequential = nextLedgerToApply(db);
  const liveFrom =
    liveCompleteFrom !== null &&
    liveCompleteFrom !== undefined &&
    liveCompleteFrom <= tipIndex &&
    liveCompleteFrom > 0
      ? liveCompleteFrom
      : tipIndex;
  const gap = readLiveGap(db);
  if (gap && sequential <= gap.through) {
    return liveFrom;
  }
  return sequential;
}

async function readLiveCompleteFrom(
  source: LiveLedgerSource,
  tipIndex: number,
): Promise<number | null> {
  if (source.getCompleteLedgers === undefined) {
    return null;
  }
  try {
    const raw = await source.getCompleteLedgers();
    const range = completeRangeContaining(parseCompleteLedgers(raw), tipIndex);
    return range?.from ?? null;
  } catch {
    return null;
  }
}

export async function catchUpLedgers(options: {
  db: SqliteDatabase;
  source: Pick<LiveLedgerSource, 'getLedgerWithTransactions' | 'quota'>;
  log: LiveLogger;
  through: number;
  minIndex?: number;
  signal?: AbortSignal;
  onApplied?: (result: ApplyClosedLedgerResult) => void;
  retryMinMs?: number;
}): Promise<ApplyClosedLedgerResult[]> {
  const { db, source, log, through } = options;
  const applied: ApplyClosedLedgerResult[] = [];
  let index = Math.max(nextLedgerToApply(db), options.minIndex ?? 0);
  source.quota?.beginLive();
  try {
    while (index <= through) {
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error('aborted');
      }
      const ledger: ClosedLedger = await retry(
        () =>
          withQuota(
            source.quota,
            'live',
            () => source.getLedgerWithTransactions(index),
            options.signal,
          ),
        {
          minMs: options.retryMinMs ?? 1_000,
          maxMs: 60_000,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          onRetry: ({ waitMs, rateLimited, error }) => {
            log.warn(
              { ledger: index, waitMs, err: error },
              rateLimited ? 'live ledger fetch rate-limited, waiting' : 'live ledger fetch retrying',
            );
          },
        },
      );
      const result = applyClosedLedger(db, ledger, log);
      applied.push(result);
      if (result.applied) {
        options.onApplied?.(result);
        log.info(
          { ledger: result.index, txApplied: result.txApplied, tokensTouched: result.tokensTouched },
          'live ledger applied',
        );
      }
      index = Math.max(nextLedgerToApply(db), options.minIndex ?? 0);
      if (result.skipped && index === ledger.index) {
        index = ledger.index + 1;
      }
    }
  } finally {
    source.quota?.endLive();
  }
  return applied;
}

class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  add(work: () => Promise<void>): Promise<void> {
    const run = this.tail.then(work, work);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  drain(): Promise<void> {
    return this.tail;
  }
}

export async function followLive(options: {
  db: SqliteDatabase;
  source: LiveLedgerSource;
  runtime: Runtime;
  log: LiveLogger;
  signal?: AbortSignal;
  onApplied?: (result: ApplyClosedLedgerResult) => void;
  retryMinMs?: number;
}): Promise<void> {
  const { db, source, runtime, log } = options;
  const retryMinMs = options.retryMinMs ?? 1_000;
  const tip = await retry(
    () => withQuota(source.quota, 'live', () => source.getValidatedLedger(), options.signal),
    {
      minMs: retryMinMs,
      maxMs: 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onRetry: ({ waitMs, rateLimited }) => {
        log.warn(
          { waitMs, rateLimited },
          rateLimited ? 'live tip fetch rate-limited, waiting' : 'live tip fetch retrying',
        );
      },
    },
  );
  runtime.networkLedgerIndex = tip.index;
  const liveCompleteFrom = await readLiveCompleteFrom(source, tip.index);
  const gap = recordLiveSubscribeGap(db, tip.index, liveCompleteFrom);
  const minIndex = liveCatchUpFloor(db, tip.index, liveCompleteFrom);
  if (gap) {
    log.info(
      { from: gap.from, through: gap.through, tip: tip.index, liveFrom: minIndex },
      'live subscribe at tip; backfill will fill the gap first',
    );
  }
  const appliedOpts = {
    db,
    source,
    log,
    minIndex,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
    retryMinMs,
  };

  await retry(
    () => withQuota(source.quota, 'live', () => source.subscribeLedgers(), options.signal),
    {
      minMs: retryMinMs,
      maxMs: 60_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      onRetry: ({ waitMs, rateLimited }) => {
        log.warn(
          { waitMs, rateLimited },
          rateLimited ? 'live subscribe rate-limited, waiting' : 'live subscribe retrying',
        );
      },
    },
  );
  const queue = new SerialQueue();

  const handleClosed = (closed: ValidatedLedger): void => {
    runtime.networkLedgerIndex = Math.max(runtime.networkLedgerIndex ?? closed.index, closed.index);
    void queue.add(async () => {
      try {
        await catchUpLedgers({
          ...appliedOpts,
          through: closed.index,
        });
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        log.error({ err: error, ledger: closed.index }, 'live ledger apply failed');
      }
    });
  };

  const unsubscribe = source.onLedgerClosed(handleClosed);
  if (options.signal?.aborted) {
    unsubscribe();
    return;
  }

  try {
    await catchUpLedgers({
      ...appliedOpts,
      through: tip.index,
    });
  } catch (error) {
    if (options.signal?.aborted) {
      unsubscribe();
      return;
    }
    throw error;
  }

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      unsubscribe();
      void queue.drain().then(() => {
        resolve();
      });
    };
    if (options.signal === undefined) {
      return;
    }
    if (options.signal.aborted) {
      finish();
      return;
    }
    options.signal.addEventListener('abort', finish, { once: true });
  });
}
