import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, getLatestLedgerIndex } from '../db/queries/indexer.js';
import type { Runtime } from '../runtime.js';
import { withQuota } from '../util/quota.js';
import { retry } from '../util/retry.js';
import { applyClosedLedger, snapshotLedgerBound, type ApplyClosedLedgerResult } from './ledger.js';
import type { ApplyLogger } from './objects.js';
import type { ClosedLedger, LiveLedgerSource, ValidatedLedger } from './source.js';

export interface LiveLogger extends ApplyLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
  debug?: (obj: Record<string, unknown>, msg: string) => void;
}

function nextLedgerToApply(db: SqliteDatabase): number {
  const latest = getLatestLedgerIndex(db);
  const liveFromRaw = getIndexerState(db, 'live_from_ledger');
  const liveFrom = liveFromRaw === undefined ? 0 : Number.parseInt(liveFromRaw, 10);
  const snapshot = snapshotLedgerBound(db);
  const candidate = Math.max(latest + 1, Number.isInteger(liveFrom) ? liveFrom : 0);
  return candidate <= snapshot ? snapshot + 1 : candidate;
}

export async function catchUpLedgers(options: {
  db: SqliteDatabase;
  source: Pick<LiveLedgerSource, 'getLedgerWithTransactions' | 'quota'>;
  log: LiveLogger;
  through: number;
  signal?: AbortSignal;
  onApplied?: (result: ApplyClosedLedgerResult) => void;
  retryMinMs?: number;
}): Promise<ApplyClosedLedgerResult[]> {
  const { db, source, log, through } = options;
  const applied: ApplyClosedLedgerResult[] = [];
  let index = nextLedgerToApply(db);
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
          onRetry: ({ waitMs, rateLimited }) => {
            if (rateLimited) {
              log.warn({ ledger: index, waitMs }, 'live ledger fetch rate-limited, waiting');
            }
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
      index = nextLedgerToApply(db);
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
  const appliedOpts = {
    db,
    source,
    log,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onApplied === undefined ? {} : { onApplied: options.onApplied }),
    retryMinMs,
  };
  await catchUpLedgers({
    ...appliedOpts,
    through: tip.index,
  });

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
