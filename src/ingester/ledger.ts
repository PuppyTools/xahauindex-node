import type { SqliteDatabase } from '../db/client.js';
import { getIndexerState, hasLedger, upsertLedger } from '../db/queries/indexer.js';
import { recomputeTokenAggregates } from '../db/queries/tokens.js';
import type { DexTradeRow } from '../types/db.js';
import { serializeAmount } from '../util/xahau.js';
import { applyExecutedOffers } from './dex.js';
import { parseAffectedNode, parseLedgerTx } from './guards.js';
import {
  applyAffectedLedgerNode,
  applySetRemarks,
  type ApplyLogger,
} from './objects.js';
import type { ClosedLedger } from './source.js';

export type UriTokenLiveEvent = 'mint' | 'burn' | 'transfer' | 'update';

export interface ApplyClosedLedgerResult {
  applied: boolean;
  skipped: boolean;
  reason?: 'already_indexed' | 'at_or_before_snapshot';
  index: number;
  txApplied: number;
  tokensTouched: number;
  tokenIds: string[];
  uriTokenEvents: Array<{ id: string; event: UriTokenLiveEvent }>;
  hookAccounts: string[];
  trades: Array<Omit<DexTradeRow, 'id'>>;
}

function emptyResult(
  index: number,
  extras: Pick<ApplyClosedLedgerResult, 'applied' | 'skipped'> &
    Partial<Pick<ApplyClosedLedgerResult, 'reason' | 'txApplied' | 'tokensTouched'>>,
): ApplyClosedLedgerResult {
  return {
    applied: extras.applied,
    skipped: extras.skipped,
    index,
    txApplied: extras.txApplied ?? 0,
    tokensTouched: extras.tokensTouched ?? 0,
    tokenIds: [],
    uriTokenEvents: [],
    hookAccounts: [],
    trades: [],
    ...(extras.reason === undefined ? {} : { reason: extras.reason }),
  };
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
    return emptyResult(ledger.index, { applied: false, skipped: true, reason: 'already_indexed' });
  }
  if (ledger.index <= snapshotLedgerBound(db)) {
    return emptyResult(ledger.index, {
      applied: false,
      skipped: true,
      reason: 'at_or_before_snapshot',
    });
  }

  const apply = db.transaction((): ApplyClosedLedgerResult => {
    const touched = new Set<string>();
    const uriTokenEvents: ApplyClosedLedgerResult['uriTokenEvents'] = [];
    const hookAccounts = new Set<string>();
    const trades: ApplyClosedLedgerResult['trades'] = [];
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
      const nodes = [];
      for (const rawNode of tx.affectedNodes) {
        const node = parseAffectedNode(rawNode);
        if (!node) {
          continue;
        }
        nodes.push(node);
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
        if (node.type === 'URIToken') {
          const event =
            node.kind === 'created'
              ? 'mint'
              : node.kind === 'deleted'
                ? 'burn'
                : typeof node.previous?.Owner === 'string' &&
                    typeof node.fields.Owner === 'string' &&
                    node.previous.Owner !== node.fields.Owner
                  ? 'transfer'
                  : 'update';
          uriTokenEvents.push({ id: node.index, event });
        }
        if (node.type === 'AccountRoot' && (node.kind === 'created' || 'Hook' in node.fields)) {
          const account = node.fields.Account;
          if (typeof account === 'string') {
            hookAccounts.add(account);
          }
        }
      }
      if (tx.transactionType === 'SetRemarks' && tx.objectId && tx.remarks !== undefined) {
        applySetRemarks(db, tx.objectId, tx.remarks, ledger.index);
      }
      trades.push(...applyExecutedOffers(db, tx, nodes, ledger.index, ledger.closeTime, log));
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
      tokenIds: [...touched],
      uriTokenEvents,
      hookAccounts: [...hookAccounts],
      trades,
    };
  });
  return apply();
}
