import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, getLatestLedgerIndex, setIndexerState } from '../db/queries/indexer.js';
import type { Runtime } from '../runtime.js';
import { withQuota } from '../util/quota.js';
import { retry } from '../util/retry.js';
import { applyClosedLedger, snapshotLedgerBound, type ApplyClosedLedgerResult } from './ledger.js';
import type { ApplyLogger } from './objects.js';
import {
  completeRangeContaining,
  isLedgerNotFound,
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

/** Live subscribe always starts at the node's current validated ledger. */
export function subscribeLiveFrom(_sequential: number, tipIndex: number): number {
  return tipIndex;
}

export function recordLiveSubscribeGap(
  db: SqliteDatabase,
  tipIndex: number,
  _liveCompleteFrom?: number | null,
): LiveGap | null {
  const sequential = nextLedgerToApply(db);
  const liveFrom = subscribeLiveFrom(sequential, tipIndex);
  const existing = readLiveGap(db);
  if (existing) {
    const through = liveFrom - 1;
    if (through > existing.through) {
      setIndexerState(db, LIVE_GAP_THROUGH, String(through));
      return { ...existing, through };
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
  _liveCompleteFrom?: number | null,
): number {
  const sequential = nextLedgerToApply(db);
  const liveFrom = subscribeLiveFrom(sequential, tipIndex);
  const gap = readLiveGap(db);
  if (gap && sequential <= gap.through) {
    return liveFrom;
  }
  return sequential;
}

export async function resolveLiveAvailable(
  source: Pick<LiveLedgerSource, 'getValidatedLedger' | 'getCompleteLedgers'>,
  fallbackThrough: number,
): Promise<{ from: number; to: number }> {
  let tip = fallbackThrough;
  try {
    tip = (await source.getValidatedLedger()).index;
  } catch {
    // use the stream / caller index
  }
  if (source.getCompleteLedgers === undefined) {
    return { from: tip, to: tip };
  }
  try {
    const range = completeRangeContaining(parseCompleteLedgers(await source.getCompleteLedgers()), tip);
    if (range !== null) {
      return { from: range.from, to: Math.min(range.to, tip) };
    }
  } catch {
    // fall through
  }
  return { from: tip, to: tip };
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
  fetchAttempts?: number;
  giveUpIfMissing?: boolean;
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
      let ledger: ClosedLedger;
      try {
        ledger = await retry(
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
            ...(options.fetchAttempts === undefined ? {} : { attempts: options.fetchAttempts }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onRetry: ({ waitMs, rateLimited, error }) => {
              if (rateLimited) {
                log.warn({ ledger: index, waitMs, err: error }, 'live ledger fetch rate-limited, waiting');
                return;
              }
              if (isLedgerNotFound(error)) {
                log.info({ ledger: index, waitMs }, 'live ledger not on node yet, waiting');
                return;
              }
              log.warn({ ledger: index, waitMs, err: error }, 'live ledger fetch retrying');
            },
          },
        );
      } catch (error) {
        if (options.giveUpIfMissing && isLedgerNotFound(error)) {
          log.info({ ledger: index }, 'live ledger not on node yet, waiting for next close');
          break;
        }
        throw error;
      }
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
  const available = await resolveLiveAvailable(source, tip.index);
  const liveFrom = available.to;
  const gap = recordLiveSubscribeGap(db, liveFrom);
  if (gap) {
    log.info(
      { from: gap.from, through: gap.through, tip: liveFrom, completeFrom: available.from },
      'live subscribe at current ledger; backfill will fill the gap first',
    );
  }
  const appliedOpts = {
    db,
    source,
    log,
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

  const applyAvailable = async (wantThrough: number): Promise<void> => {
    const have = await resolveLiveAvailable(source, wantThrough);
    runtime.networkLedgerIndex = Math.max(runtime.networkLedgerIndex ?? have.to, have.to);
    const sequential = nextLedgerToApply(db);
    let start = sequential;
    if (start < have.from) {
      recordLiveSubscribeGap(db, have.to);
      start = have.to;
    }
    const through = Math.min(wantThrough, have.to);
    if (start > through) {
      return;
    }
    await catchUpLedgers({
      ...appliedOpts,
      through,
      minIndex: start,
      fetchAttempts: 2,
      giveUpIfMissing: true,
    });
  };

  const handleClosed = (closed: ValidatedLedger): void => {
    runtime.networkLedgerIndex = Math.max(runtime.networkLedgerIndex ?? closed.index, closed.index);
    void queue.add(async () => {
      try {
        await applyAvailable(closed.index);
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
    await applyAvailable(liveFrom);
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
