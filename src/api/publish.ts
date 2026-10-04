import type { SqliteDatabase } from '../db/client.js';
import { getHookAccount } from '../db/queries/hooks.js';
import { getToken } from '../db/queries/tokens.js';
import { getUriToken } from '../db/queries/uritokens.js';
import type { ApplyClosedLedgerResult } from '../ingester/ledger.js';
import type { EventHub } from './hub.js';
import { hookStateFromRow, tokenFromRow, uriTokenFromRow } from './mappers.js';

export function publishLedgerEvents(
  hub: EventHub,
  db: SqliteDatabase,
  result: ApplyClosedLedgerResult,
): void {
  if (!result.applied) {
    return;
  }
  for (const id of result.tokenIds) {
    const row = getToken(db, id);
    if (row) {
      hub.publish({
        stream: 'tokens',
        event: 'update',
        data: tokenFromRow(row),
        ledger_index: result.index,
      });
    }
  }
  for (const item of result.uriTokenEvents) {
    const row = getUriToken(db, item.id);
    if (row) {
      hub.publish({
        stream: 'uritokens',
        event: item.event,
        data: uriTokenFromRow(row),
        ledger_index: result.index,
      });
    }
  }
  if (result.trades.length > 0) {
    hub.publish({
      stream: 'prices',
      event: 'trade',
      data: result.trades,
      ledger_index: result.index,
    });
  }
  for (const account of result.hookAccounts) {
    const row = getHookAccount(db, account);
    if (row) {
      hub.publish({
        stream: 'hooks',
        event: 'update',
        data: hookStateFromRow(row),
        ledger_index: result.index,
      });
    }
  }
}
