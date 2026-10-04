import { publishLedgerEvents } from '../api/publish.js';
import type { EventHub } from '../api/hub.js';
import { resolveBackfillFrom, resolveBackfillSourceUrl, type Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import type { Runtime } from '../runtime.js';
import { runBackfill, type BackfillResult } from './backfill.js';
import { snapshotLedgerBound } from './ledger.js';
import { followLive, type LiveLogger } from './live.js';
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
    });
    if (options.runtime.networkLedgerIndex === null) {
      options.runtime.networkLedgerIndex = result.ledger;
    }
    if (options.signal?.aborted) {
      return;
    }
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
    await Promise.all([live, toml, uriMeta, backfill]);
  } finally {
    await source.disconnect();
  }
}

export async function runDedicatedBackfill(options: {
  db: SqliteDatabase;
  liveSource: Pick<XahauSource, 'getLedgerWithTransactions'>;
  config: Config;
  log: LiveLogger;
  signal?: AbortSignal;
  fetchAttempts?: number;
  retryMinMs?: number;
}): Promise<BackfillResult> {
  const url = resolveBackfillSourceUrl(options.config);
  const snapshot = snapshotLedgerBound(options.db);
  const from = snapshot >= 1 ? resolveBackfillFrom(options.config, snapshot) : null;
  const dedicated = from !== null && url !== options.config.xahaudUrl;
  const history = dedicated ? createBackfillSource(url) : null;
  if (history) {
    await history.connect();
    options.log.info(
      {
        url,
        ...(options.config.backfillEnvPath === null ? {} : { env: options.config.backfillEnvPath }),
      },
      'historical backfill using dedicated node',
    );
  }
  try {
    return await runBackfill({
      db: options.db,
      source: history ?? options.liveSource,
      config: options.config,
      log: options.log,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.fetchAttempts === undefined ? {} : { fetchAttempts: options.fetchAttempts }),
      ...(options.retryMinMs === undefined ? {} : { retryMinMs: options.retryMinMs }),
    });
  } finally {
    if (history) {
      await history.disconnect();
    }
  }
}
