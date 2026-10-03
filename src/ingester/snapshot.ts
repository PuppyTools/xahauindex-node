import type { SqliteDatabase } from '../db/client.js';
import {
  getIndexerState,
  setIndexerState,
  upsertLedger,
} from '../db/queries/indexer.js';
import { recomputeTokenAggregates, syncTokenIssuerFlags } from '../db/queries/tokens.js';
import { retry } from '../util/retry.js';
import {
  applyCachedAccountRoots,
  applyLedgerObject,
  type AccountRootCache,
  type ApplyLogger,
} from './objects.js';
import type { LedgerSource } from './source.js';

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

export async function runSnapshot(options: {
  db: SqliteDatabase;
  source: LedgerSource;
  log: SnapshotLogger;
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
  const accountCache: AccountRootCache = new Map();

  for (;;) {
    const page = await retry(() => source.getLedgerDataPage(snapshotLedger, marker), {
      minMs: 1_000,
      maxMs: 30_000,
      attempts: 6,
    });
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
