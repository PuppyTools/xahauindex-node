import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, hasLedger, upsertLedger } from '../db/queries/indexer.js';
import { recomputeTokenAggregates } from '../db/queries/tokens.js';
import { serializeAmount } from '../util/xahau.js';
import { parseAffectedNode, parseLedgerTx } from './guards.js';
import {
  applyAffectedLedgerNode,
  applySetRemarks,
  type ApplyLogger,
} from './objects.js';
import type { ClosedLedger } from './source.js';

export interface ApplyClosedLedgerResult {
  applied: boolean;
  skipped: boolean;
  reason?: 'already_indexed' | 'at_or_before_snapshot';
  index: number;
  txApplied: number;
  tokensTouched: number;
}

export function snapshotLedgerBound(db: SqliteDatabase): number {
  const raw = getIndexerState(db, 'snapshot_ledger');
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : -1;
}

export function applyClosedLedger(
  db: SqliteDatabase,
  ledger: ClosedLedger,
  log: ApplyLogger,
): ApplyClosedLedgerResult {
  if (hasLedger(db, ledger.index)) {
    return {
      applied: false,
      skipped: true,
      reason: 'already_indexed',
      index: ledger.index,
      txApplied: 0,
      tokensTouched: 0,
    };
  }
  if (ledger.index <= snapshotLedgerBound(db)) {
    return {
      applied: false,
      skipped: true,
      reason: 'at_or_before_snapshot',
      index: ledger.index,
      txApplied: 0,
      tokensTouched: 0,
    };
  }

  const apply = db.transaction((): ApplyClosedLedgerResult => {
    const touched = new Set<string>();
    let txApplied = 0;
    for (const raw of ledger.transactions) {
      const tx = parseLedgerTx(raw);
      if (!tx) {
        continue;
      }
      if (tx.result !== 'tesSUCCESS') {
        continue;
      }
      txApplied += 1;
      const transfer =
        tx.hash === ''
          ? undefined
          : {
              txHash: tx.hash,
              price: serializeAmount(tx.amount),
            };
      for (const rawNode of tx.affectedNodes) {
        const node = parseAffectedNode(rawNode);
        if (!node) {
          continue;
        }
        const token = applyAffectedLedgerNode(
          db,
          node,
          ledger.index,
          log,
          transfer,
        );
        if (token) {
          touched.add(token);
        }
      }
      if (tx.transactionType === 'SetRemarks' && tx.objectId && tx.remarks !== undefined) {
        applySetRemarks(db, tx.objectId, tx.remarks, ledger.index);
      }
    }
    recomputeTokenAggregates(db, touched, ledger.index);
    upsertLedger(db, {
      ledger_index: ledger.index,
      close_time: ledger.closeTime,
      hash: ledger.hash === '' ? '0'.repeat(64) : ledger.hash,
      tx_count: ledger.transactions.length,
      indexed_at: Math.floor(Date.now() / 1000),
    });
    return {
      applied: true,
      skipped: false,
      index: ledger.index,
      txApplied,
      tokensTouched: touched.size,
    };
  });
  return apply();
}
