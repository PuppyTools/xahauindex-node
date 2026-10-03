import type { HookAccountRow } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

export function getHookAccount(db: SqliteDatabase, account: string): HookAccountRow | undefined {
  return db.prepare('SELECT * FROM hook_accounts WHERE account = ?').get(account) as
    | HookAccountRow
    | undefined;
}

export function upsertHookAccount(db: SqliteDatabase, row: HookAccountRow): void {
  db.prepare(
    `
    INSERT INTO hook_accounts (account, hook_count, hooks_json, first_ledger, last_updated)
    VALUES (@account, @hook_count, @hooks_json, @first_ledger, @last_updated)
    ON CONFLICT(account) DO UPDATE SET
      hook_count = excluded.hook_count,
      hooks_json = excluded.hooks_json,
      last_updated = excluded.last_updated
    `,
  ).run(row);
}

export function listHookAccounts(
  db: SqliteDatabase,
  opts: { page: number; perPage: number; hookHash?: string },
): HookAccountRow[] {
  const params: Record<string, string | number> = {
    limit: opts.perPage,
    offset: (opts.page - 1) * opts.perPage,
  };
  if (opts.hookHash !== undefined) {
    params.hook_hash = `%"${opts.hookHash}"%`;
    return db
      .prepare(
        `
        SELECT * FROM hook_accounts
        WHERE hooks_json LIKE @hook_hash
        ORDER BY account ASC
        LIMIT @limit OFFSET @offset
        `,
      )
      .all(params) as HookAccountRow[];
  }
  return db
    .prepare(
      `
      SELECT * FROM hook_accounts
      ORDER BY account ASC
      LIMIT @limit OFFSET @offset
      `,
    )
    .all(params) as HookAccountRow[];
}
