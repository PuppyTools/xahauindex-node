import type { SqliteDatabase } from '../db/client.js';
import {
  getIndexerState,
  resetIncompleteSnapshot,
  setIndexerState,
  upsertLedger,
} from '../db/queries/indexer.js';
import { recomputeTokenAggregates, syncTokenIssuerFlags } from '../db/queries/tokens.js';
import { retry, sleep } from '../util/retry.js';
import {
  applyCachedAccountRoots,
  applyLedgerObject,
  type AccountRootCache,
  type ApplyLogger,
} from './objects.js';
import { isLedgerNotFound, type LedgerDataPageResult, type LedgerSource } from './source.js';

export interface SnapshotLogger extends ApplyLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface SnapshotResult {
  skipped: boolean;
  ledger: number;
  pages: number;
  objects: number;
}

function encodeMarker(marker: unknown): string {
  return JSON.stringify(marker);
}

function decodeMarker(raw: string | undefined): unknown {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  return JSON.parse(raw) as unknown;
}

async function fetchSnapshotPage(
  source: LedgerSource,
  ledger: number,
  marker: unknown,
  log: SnapshotLogger,
  attempts: number,
  minMs: number,
  signal?: AbortSignal,
): Promise<LedgerDataPageResult> {
  const fetch = (): Promise<LedgerDataPageResult> => source.getLedgerDataPage(ledger, marker);
  const retryOpts = {
    minMs,
    maxMs: 30_000,
    attempts,
    ...(signal === undefined ? {} : { signal }),
  };
  try {
    return await retry(fetch, retryOpts);
  } catch (error) {
    if (!isLedgerNotFound(error) || source.reconnect === undefined) {
      throw error;
    }
    log.warn({ ledger, err: error }, 'snapshot ledger_data missing; reconnecting');
    await source.reconnect();
    return await retry(fetch, retryOpts);
  }
}

export async function runSnapshot(options: {
  db: SqliteDatabase;
  source: LedgerSource;
  log: SnapshotLogger;
  pageAttempts?: number;
  retryMinMs?: number;
  signal?: AbortSignal;
}): Promise<SnapshotResult> {
  const { db, source, log } = options;
  if (getIndexerState(db, 'snapshot_status') === 'complete') {
    const ledger = Number.parseInt(getIndexerState(db, 'snapshot_ledger') ?? '0', 10);
    return { skipped: true, ledger, pages: 0, objects: 0 };
  }

  let snapshotLedger = Number.parseInt(getIndexerState(db, 'snapshot_ledger') ?? '', 10);
  let hash = getIndexerState(db, 'snapshot_hash') ?? '';
  let closeTime = Number.parseInt(getIndexerState(db, 'snapshot_close_time') ?? '', 10);
  if (!Number.isInteger(snapshotLedger) || snapshotLedger <= 0) {
    const validated = await source.getValidatedLedger();
    snapshotLedger = validated.index;
    hash = validated.hash;
    closeTime = validated.closeTime;
    setIndexerState(db, 'snapshot_ledger', String(snapshotLedger));
    setIndexerState(db, 'snapshot_hash', hash);
    setIndexerState(db, 'snapshot_close_time', String(closeTime));
    setIndexerState(db, 'snapshot_marker', '');
  }
  setIndexerState(db, 'snapshot_status', 'running');

  let marker = decodeMarker(getIndexerState(db, 'snapshot_marker'));
  let pages = 0;
  let objects = 0;
  let sameLedgerMisses = 0;
  const accountCache: AccountRootCache = new Map();
  const pageAttempts = options.pageAttempts ?? 6;
  const retryMinMs = options.retryMinMs ?? 1_000;

  for (;;) {
    if (options.signal?.aborted) {
      throw options.signal.reason ?? new Error('aborted');
    }
    let page: LedgerDataPageResult;
    try {
      page = await fetchSnapshotPage(
        source,
        snapshotLedger,
        marker,
        log,
        pageAttempts,
        retryMinMs,
        options.signal,
      );
      sameLedgerMisses = 0;
    } catch (error) {
      if (!isLedgerNotFound(error)) {
        throw error;
      }
      const tip = await source.getValidatedLedger();
      if (tip.index !== snapshotLedger) {
        log.warn(
          { from: snapshotLedger, to: tip.index, err: error },
          'snapshot ledger gone; restarting on current tip',
        );
        resetIncompleteSnapshot(db);
        snapshotLedger = tip.index;
        hash = tip.hash;
        closeTime = tip.closeTime;
        setIndexerState(db, 'snapshot_ledger', String(snapshotLedger));
        setIndexerState(db, 'snapshot_hash', hash);
        setIndexerState(db, 'snapshot_close_time', String(closeTime));
        setIndexerState(db, 'snapshot_status', 'running');
        marker = undefined;
        pages = 0;
        objects = 0;
        sameLedgerMisses = 0;
        accountCache.clear();
        continue;
      }
      sameLedgerMisses += 1;
      if (sameLedgerMisses >= pageAttempts) {
        throw error;
      }
      log.warn({ ledger: snapshotLedger, miss: sameLedgerMisses }, 'snapshot ledger still missing; retrying');
      await sleep(retryMinMs, options.signal);
      continue;
    }
    const apply = db.transaction(() => {
      for (const item of page.state) {
        applyLedgerObject(db, item, snapshotLedger, log, accountCache);
      }
      if (page.marker === undefined) {
        setIndexerState(db, 'snapshot_marker', '');
      } else {
        setIndexerState(db, 'snapshot_marker', encodeMarker(page.marker));
      }
    });
    apply();
    pages += 1;
    objects += page.state.length;
    log.info({ ledger: snapshotLedger, pages, objects }, 'snapshot page applied');
    if (page.marker === undefined) {
      break;
    }
    marker = page.marker;
  }

  const finalize = db.transaction(() => {
    applyCachedAccountRoots(db, accountCache, snapshotLedger);
    recomputeTokenAggregates(db);
    syncTokenIssuerFlags(db);
    upsertLedger(db, {
      ledger_index: snapshotLedger,
      close_time: Number.isInteger(closeTime) ? closeTime : 0,
      hash: hash === '' ? '0'.repeat(64) : hash,
      tx_count: 0,
      indexed_at: Math.floor(Date.now() / 1000),
    });
    setIndexerState(db, 'live_from_ledger', String(snapshotLedger + 1));
    setIndexerState(db, 'snapshot_status', 'complete');
    setIndexerState(db, 'snapshot_marker', '');
  });
  finalize();

  log.info({ ledger: snapshotLedger, pages, objects }, 'snapshot complete');
  return { skipped: false, ledger: snapshotLedger, pages, objects };
}
