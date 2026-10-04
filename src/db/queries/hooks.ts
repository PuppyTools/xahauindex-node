import type { HookAccountRow, HookDefinitionRow } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

export function getHookAccount(db: SqliteDatabase, account: string): HookAccountRow | undefined {
  return db.prepare('SELECT * FROM hook_accounts WHERE account = ?').get(account) as
    | HookAccountRow
    | undefined;
}

export function deleteHookAccount(db: SqliteDatabase, account: string): void {
  db.prepare('DELETE FROM hook_accounts WHERE account = ?').run(account);
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
        WHERE hook_count > 0 AND hooks_json LIKE @hook_hash
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
      WHERE hook_count > 0
      ORDER BY account ASC
      LIMIT @limit OFFSET @offset
      `,
    )
    .all(params) as HookAccountRow[];
}

export function getHookDefinition(db: SqliteDatabase, hookHash: string): HookDefinitionRow | undefined {
  return db.prepare('SELECT * FROM hook_definitions WHERE hook_hash = ?').get(hookHash) as
    | HookDefinitionRow
    | undefined;
}

export function deleteHookDefinition(db: SqliteDatabase, hookHash: string): void {
  db.prepare('DELETE FROM hook_definitions WHERE hook_hash = ?').run(hookHash);
}

export function upsertHookDefinition(db: SqliteDatabase, row: HookDefinitionRow): void {
  db.prepare(
    `
    INSERT INTO hook_definitions (
      hook_hash, hook_namespace, hook_on, hook_on_incoming, hook_on_outgoing,
      hook_can_emit, hook_name, hook_api_version, parameters_json, reference_count,
      code_size, hook_fee, hook_callback_fee, hook_set_txn_id, flags,
      first_ledger, last_updated
    ) VALUES (
      @hook_hash, @hook_namespace, @hook_on, @hook_on_incoming, @hook_on_outgoing,
      @hook_can_emit, @hook_name, @hook_api_version, @parameters_json, @reference_count,
      @code_size, @hook_fee, @hook_callback_fee, @hook_set_txn_id, @flags,
      @first_ledger, @last_updated
    )
    ON CONFLICT(hook_hash) DO UPDATE SET
      hook_namespace = excluded.hook_namespace,
      hook_on = excluded.hook_on,
      hook_on_incoming = excluded.hook_on_incoming,
      hook_on_outgoing = excluded.hook_on_outgoing,
      hook_can_emit = excluded.hook_can_emit,
      hook_name = excluded.hook_name,
      hook_api_version = excluded.hook_api_version,
      parameters_json = excluded.parameters_json,
      reference_count = excluded.reference_count,
      code_size = excluded.code_size,
      hook_fee = excluded.hook_fee,
      hook_callback_fee = excluded.hook_callback_fee,
      hook_set_txn_id = excluded.hook_set_txn_id,
      flags = excluded.flags,
      last_updated = excluded.last_updated
    `,
  ).run(row);
}

export function listHookDefinitionsByHashes(
  db: SqliteDatabase,
  hashes: string[],
): Map<string, HookDefinitionRow> {
  const out = new Map<string, HookDefinitionRow>();
  if (hashes.length === 0) {
    return out;
  }
  const unique = [...new Set(hashes)];
  const placeholders = unique.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM hook_definitions WHERE hook_hash IN (${placeholders})`)
    .all(...unique) as HookDefinitionRow[];
  for (const row of rows) {
    out.set(row.hook_hash, row);
  }
  return out;
}

export function listHookDefinitions(
  db: SqliteDatabase,
  opts: { page: number; perPage: number },
): HookDefinitionRow[] {
  return db
    .prepare(
      `
      SELECT * FROM hook_definitions
      ORDER BY reference_count DESC, hook_hash ASC
      LIMIT ? OFFSET ?
      `,
    )
    .all(opts.perPage, (opts.page - 1) * opts.perPage) as HookDefinitionRow[];
}
