import { publishLedgerEvents } from '../api/publish.js';
import type { EventHub } from '../api/hub.js';
import {
  MAX_BACKFILL_CONCURRENCY,
  resolveBackfillConcurrency,
  resolveBackfillFrom,
  resolveBackfillMinIntervalMs,
  resolveBackfillSourceUrl,
  resolveGapFillMinIntervalMs,
  type Config,
} from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import type { Runtime } from '../runtime.js';
import { fillLiveGap, runBackfill, type BackfillResult } from './backfill.js';
import { runHistoryDbImport } from './historyDb.js';
import { snapshotLedgerBound } from './ledger.js';
import {
  followLive,
  liveCatchUpFloor,
  nextLedgerToApply,
  readLiveGap,
  recordLiveSubscribeGap,
  type LiveLogger,
} from './live.js';
import { completeRangeContaining, parseCompleteLedgers } from './source.js';
import { runSnapshot } from './snapshot.js';
import { createBackfillSource, createXahauSource, type XahauSource } from './source.js';
import { runUriMetaWorker } from './metadata.js';
import { runTomlWorker } from './toml.js';

export async function startIngester(options: {
  db: SqliteDatabase;
  config: Config;
  runtime: Runtime;
  log: LiveLogger;
  signal?: AbortSignal;
  hub?: EventHub;
}): Promise<void> {
  const source = createXahauSource(options.config.xahaudUrl);
  await source.connect();
  try {
    if (options.signal?.aborted) {
      return;
    }
    const tip = await source.getValidatedLedger();
    options.runtime.networkLedgerIndex = tip.index;
    const result = await runSnapshot({
      db: options.db,
      source,
      log: options.log,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options.runtime.networkLedgerIndex === null) {
      options.runtime.networkLedgerIndex = result.ledger;
    }
    if (options.signal?.aborted) {
      return;
    }
    let completeFrom: number | null = null;
    try {
      if (source.getCompleteLedgers !== undefined) {
        completeFrom =
          completeRangeContaining(
            parseCompleteLedgers(await source.getCompleteLedgers()),
            tip.index,
          )?.from ?? null;
      }
    } catch {
      completeFrom = null;
    }
    const gap = recordLiveSubscribeGap(options.db, tip.index, completeFrom);
    const liveFrom = liveCatchUpFloor(options.db, tip.index, completeFrom);
    options.log.info(
      {
        tip: tip.index,
        lastNext: nextLedgerToApply(options.db),
        completeFrom,
        liveFrom,
        ...(gap === null ? {} : { gapFrom: gap.from, gapThrough: gap.through }),
      },
      gap === null
        ? 'live subscribe at tip'
        : 'live subscribe at tip; backfill will fill the gap first',
    );
    const live = followLive({
      db: options.db,
      source,
      runtime: options.runtime,
      log: options.log,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.hub === undefined
        ? {}
        : {
            onApplied: (result) => {
              if (options.hub) {
                publishLedgerEvents(options.hub, options.db, result);
              }
            },
          }),
    });
    const toml = runTomlWorker({
      db: options.db,
      log: options.log,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const uriMeta = runUriMetaWorker({
      db: options.db,
      log: options.log,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const backfill = runDedicatedBackfill({
      db: options.db,
      liveSource: source,
      config: options.config,
      log: options.log,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    const settle = async (worker: string, task: Promise<unknown>): Promise<void> => {
      try {
        await task;
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        options.log.error({ err: error, worker }, 'ingester worker failed');
      }
    };
    await Promise.all([
      settle('live', live),
      settle('toml', toml),
      settle('uriMeta', uriMeta),
      settle('backfill', backfill),
    ]);
  } finally {
    await source.disconnect();
  }
}

export async function runDedicatedBackfill(options: {
  db: SqliteDatabase;
  liveSource: Pick<XahauSource, 'getLedgerWithTransactions' | 'quota'>;
  config: Config;
  log: LiveLogger;
  signal?: AbortSignal;
  fetchAttempts?: number;
  retryMinMs?: number;
}): Promise<BackfillResult> {
  const url = resolveBackfillSourceUrl(options.config);
  const snapshot = snapshotLedgerBound(options.db);
  const from = snapshot >= 1 ? resolveBackfillFrom(options.config, snapshot) : null;
  const gap = readLiveGap(options.db);
  const dedicated = url !== options.config.xahaudUrl;
  const requestedConcurrency = options.config.backfillConcurrency;
  const concurrency = resolveBackfillConcurrency(options.config, dedicated);
  const history =
    dedicated && (from !== null || gap !== null)
      ? createBackfillSource(url, { maxConcurrent: concurrency })
      : null;
  const minIntervalMs = resolveBackfillMinIntervalMs(options.config, dedicated && from !== null);
  const gapIntervalMs = resolveGapFillMinIntervalMs(options.config);
  if (!dedicated && requestedConcurrency > 1) {
    options.log.info(
      { requested: requestedConcurrency, using: 1, url },
      'BACKFILL_CONCURRENCY requires a dedicated BACKFILL_XAHAUD_URL; sharing live node at 1',
    );
  } else if (dedicated && requestedConcurrency > MAX_BACKFILL_CONCURRENCY) {
    options.log.info(
      { requested: requestedConcurrency, using: concurrency },
      'BACKFILL_CONCURRENCY capped',
    );
  }
  if (history) {
    await history.connect();
    options.log.info(
      {
        url,
        concurrency,
        minIntervalMs: gap !== null ? gapIntervalMs : minIntervalMs,
        ...(options.config.backfillEnvPath === null ? {} : { env: options.config.backfillEnvPath }),
      },
      gap !== null
        ? 'dedicated history node for live gap fill and backfill'
        : 'historical backfill using dedicated node',
    );
  } else if ((from !== null || gap !== null) && minIntervalMs > 0) {
    options.log.info(
      { minIntervalMs, url },
      'historical backfill pacing shared live node to stay under public RPC quotas',
    );
  }
  const source = history ?? options.liveSource;
  const shared = {
    db: options.db,
    source,
    log: options.log,
    concurrency,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.fetchAttempts === undefined ? {} : { fetchAttempts: options.fetchAttempts }),
    ...(options.retryMinMs === undefined ? {} : { retryMinMs: options.retryMinMs }),
  };
  try {
    await fillLiveGap({
      ...shared,
      minIntervalMs: gapIntervalMs,
    });
    if (options.config.historyFromDb) {
      try {
        await runHistoryDbImport({
          db: options.db,
          config: options.config,
          log: options.log,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch (error) {
        if (options.signal?.aborted) {
          throw options.signal.reason ?? error;
        }
        options.log.error({ err: error }, 'history DB import failed; continuing with RPC backfill');
      }
    }
    return await runBackfill({
      ...shared,
      config: options.config,
      minIntervalMs,
    });
  } finally {
    if (history) {
      await history.disconnect();
    }
  }
}
