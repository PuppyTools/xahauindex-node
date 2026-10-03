import { publishLedgerEvents } from '../api/publish.js';
import type { EventHub } from '../api/hub.js';
import type { Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import type { Runtime } from '../runtime.js';
import { followLive, type LiveLogger } from './live.js';
import { runSnapshot } from './snapshot.js';
import { createXahauSource } from './source.js';
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
    await Promise.all([live, toml]);
  } finally {
    await source.disconnect();
  }
}
