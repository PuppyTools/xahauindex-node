import type { BackfillStatus, IndexerHealth, SnapshotStatus, Status } from '../../types/api.js';
import type { SqliteDatabase } from '../client.js';
import {
  getIndexedLedgerCount,
  getIndexerState,
  getIssuerCount,
  getLatestLedgerIndex,
  getTokenCount,
  getUriTokenCount,
} from './indexer.js';

const SNAPSHOT_STATUSES: readonly SnapshotStatus[] = ['pending', 'running', 'complete'];
const BACKFILL_STATUSES: readonly BackfillStatus[] = ['idle', 'running', 'complete'];

function parseOptionalInt(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function asSnapshotStatus(value: string | undefined): SnapshotStatus {
  if (value !== undefined && (SNAPSHOT_STATUSES as readonly string[]).includes(value)) {
    return value as SnapshotStatus;
  }
  return 'pending';
}

function asBackfillStatus(value: string | undefined): BackfillStatus {
  if (value !== undefined && (BACKFILL_STATUSES as readonly string[]).includes(value)) {
    return value as BackfillStatus;
  }
  return 'idle';
}

export function readHistoryStartLedger(db: SqliteDatabase): number | null {
  const backfillFrom = parseOptionalInt(getIndexerState(db, 'backfill_from'));
  if (backfillFrom !== null) {
    return backfillFrom;
  }
  return parseOptionalInt(getIndexerState(db, 'live_from_ledger'));
}

export function readStatus(
  db: SqliteDatabase,
  startedAtMs: number,
  networkLedgerIndex: number | null,
): Status {
  const snapshotStatus = asSnapshotStatus(getIndexerState(db, 'snapshot_status'));
  const snapshotLedger = parseOptionalInt(getIndexerState(db, 'snapshot_ledger'));
  const historyStartLedger = readHistoryStartLedger(db);
  const ledgerIndex = getLatestLedgerIndex(db);
  const lag =
    networkLedgerIndex === null ? null : Math.max(0, networkLedgerIndex - ledgerIndex);

  let status: IndexerHealth = 'syncing';
  if (snapshotStatus === 'complete') {
    if (networkLedgerIndex === null) {
      status = 'degraded';
    } else if (lag !== null && lag <= 2) {
      status = 'live';
    } else {
      status = 'degraded';
    }
  }

  return {
    status,
    snapshot_status: snapshotStatus,
    snapshot_ledger: snapshotLedger,
    history_start_ledger: historyStartLedger,
    backfill_status: asBackfillStatus(getIndexerState(db, 'backfill_status')),
    backfill_from: parseOptionalInt(getIndexerState(db, 'backfill_from')),
    backfill_ledger: parseOptionalInt(getIndexerState(db, 'backfill_ledger')),
    ledger_index: ledgerIndex,
    network_ledger_index: networkLedgerIndex,
    lag_ledgers: lag,
    indexed_ledgers: getIndexedLedgerCount(db),
    token_count: getTokenCount(db),
    uri_token_count: getUriTokenCount(db),
    issuer_count: getIssuerCount(db),
    uptime_seconds: Math.max(0, Math.floor((Date.now() - startedAtMs) / 1000)),
  };
}
