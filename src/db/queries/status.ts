import type { BackfillStatus, IndexerHealth, LedgerSpan, SnapshotStatus, Status } from '../../types/api.js';
import { historyImportedRange } from '../../ingester/historyDb.js';
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

export function mergeLedgerSpans(spans: readonly LedgerSpan[]): LedgerSpan[] {
  const valid = spans
    .filter((span) => Number.isInteger(span.from) && Number.isInteger(span.through) && span.from >= 1 && span.through >= span.from)
    .map((span) => ({ from: span.from, through: span.through }))
    .sort((a, b) => a.from - b.from || a.through - b.through);
  const merged: LedgerSpan[] = [];
  for (const span of valid) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.from <= last.through + 1) {
      last.through = Math.max(last.through, span.through);
    } else {
      merged.push(span);
    }
  }
  return merged;
}

export function ledgerGapsBetween(spans: readonly LedgerSpan[]): LedgerSpan[] {
  const gaps: LedgerSpan[] = [];
  for (let index = 1; index < spans.length; index += 1) {
    const prev = spans[index - 1];
    const next = spans[index];
    if (prev === undefined || next === undefined) {
      continue;
    }
    if (next.from > prev.through + 1) {
      gaps.push({ from: prev.through + 1, through: next.from - 1 });
    }
  }
  return gaps;
}

function rpcHistorySpan(db: SqliteDatabase): LedgerSpan | null {
  const status = getIndexerState(db, 'backfill_status');
  const from = parseOptionalInt(getIndexerState(db, 'backfill_from'));
  const through = parseOptionalInt(getIndexerState(db, 'backfill_through'));
  const ledger = parseOptionalInt(getIndexerState(db, 'backfill_ledger'));
  if (status === 'complete' && from !== null && through !== null && through >= from) {
    return { from, through };
  }
  if (status === 'running' && through !== null) {
    const start = ledger ?? through;
    if (start >= 1 && through >= start) {
      return { from: start, through };
    }
  }
  return null;
}

function liveGapHole(db: SqliteDatabase, from: number, through: number): LedgerSpan | null {
  const gapFrom = parseOptionalInt(getIndexerState(db, 'live_gap_from'));
  const gapThrough = parseOptionalInt(getIndexerState(db, 'live_gap_through'));
  const gapNext = parseOptionalInt(getIndexerState(db, 'live_gap_next'));
  if (gapFrom === null || gapThrough === null || gapFrom > gapThrough) {
    return null;
  }
  const next = gapNext === null ? gapFrom : gapNext;
  if (next > gapThrough) {
    return null;
  }
  const holeFrom = Math.max(next, from);
  const holeThrough = Math.min(gapThrough, through);
  if (holeThrough < holeFrom) {
    return null;
  }
  return { from: holeFrom, through: holeThrough };
}

function currentCoverageSpans(db: SqliteDatabase, ledgerIndex: number): LedgerSpan[] {
  const snapshotStatus = getIndexerState(db, 'snapshot_status');
  const snapshot = parseOptionalInt(getIndexerState(db, 'snapshot_ledger'));
  if (snapshotStatus !== 'complete' || snapshot === null || snapshot < 1) {
    return [];
  }
  const through = Math.max(snapshot, ledgerIndex);
  const hole = liveGapHole(db, snapshot, through);
  if (hole === null) {
    return [{ from: snapshot, through }];
  }
  const spans: LedgerSpan[] = [];
  if (hole.from > snapshot) {
    spans.push({ from: snapshot, through: hole.from - 1 });
  }
  if (hole.through < through) {
    spans.push({ from: hole.through + 1, through });
  }
  return spans;
}

export function readLedgerCoverage(db: SqliteDatabase, ledgerIndex: number): {
  ranges: LedgerSpan[];
  gaps: LedgerSpan[];
} {
  const spans: LedgerSpan[] = [...currentCoverageSpans(db, ledgerIndex)];
  const imported = historyImportedRange(db);
  if (imported !== null) {
    spans.push(imported);
  }
  const rpc = rpcHistorySpan(db);
  if (rpc !== null) {
    spans.push(rpc);
  }
  const ranges = mergeLedgerSpans(spans);
  return { ranges, gaps: ledgerGapsBetween(ranges) };
}

export function readHistoryStartLedger(db: SqliteDatabase): number | null {
  const historyFrom = parseOptionalInt(getIndexerState(db, 'history_db_from'));
  const historyStatus = getIndexerState(db, 'history_db_status');
  const backfillStatus = getIndexerState(db, 'backfill_status');
  const backfillFrom = parseOptionalInt(getIndexerState(db, 'backfill_from'));
  const candidates: number[] = [];
  if ((historyStatus === 'complete' || historyStatus === 'running') && historyFrom !== null) {
    candidates.push(historyFrom);
  }
  if (backfillStatus === 'complete' && backfillFrom !== null) {
    candidates.push(backfillFrom);
  }
  if (backfillStatus === 'running') {
    const applied = parseOptionalInt(getIndexerState(db, 'backfill_ledger'));
    if (applied !== null) {
      candidates.push(applied);
    } else {
      const through = parseOptionalInt(getIndexerState(db, 'backfill_through'));
      if (through !== null) {
        candidates.push(through);
      }
    }
  }
  if (candidates.length > 0) {
    return Math.min(...candidates);
  }
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
  const coverage = readLedgerCoverage(db, ledgerIndex);
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
    ledger_ranges: coverage.ranges,
    ledger_gaps: coverage.gaps,
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
