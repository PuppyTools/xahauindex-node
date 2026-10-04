import type { RemarkRow } from '../../types/db.js';
import type { SqliteDatabase } from '../client.js';

export function upsertRemark(db: SqliteDatabase, row: RemarkRow): void {
  db.prepare(
    `
    INSERT INTO remarks (
      object_id, object_type, name, value, immutable, uri_token_id, account, token_id, last_updated
    ) VALUES (
      @object_id, @object_type, @name, @value, @immutable, @uri_token_id, @account, @token_id, @last_updated
    )
    ON CONFLICT(object_id, name) DO UPDATE SET
      value = excluded.value,
      immutable = excluded.immutable,
      object_type = excluded.object_type,
      uri_token_id = excluded.uri_token_id,
      account = excluded.account,
      token_id = excluded.token_id,
      last_updated = excluded.last_updated
    `,
  ).run(row);
}

export function deleteRemark(db: SqliteDatabase, objectId: string, name: string): void {
  db.prepare('DELETE FROM remarks WHERE object_id = ? AND name = ?').run(objectId, name);
}

export function listRemarksByObject(db: SqliteDatabase, objectId: string): RemarkRow[] {
  return db.prepare('SELECT * FROM remarks WHERE object_id = ? ORDER BY name').all(objectId) as RemarkRow[];
}

export function listRemarksByUriToken(db: SqliteDatabase, uriTokenId: string): RemarkRow[] {
  return db
    .prepare('SELECT * FROM remarks WHERE uri_token_id = ? ORDER BY name')
    .all(uriTokenId) as RemarkRow[];
}

export function listRemarksByAccount(db: SqliteDatabase, account: string): RemarkRow[] {
  return db
    .prepare('SELECT * FROM remarks WHERE account = ? ORDER BY name')
    .all(account) as RemarkRow[];
}

export function listRemarksByTokenId(db: SqliteDatabase, tokenId: string): RemarkRow[] {
  return db
    .prepare('SELECT * FROM remarks WHERE token_id = ? ORDER BY name')
    .all(tokenId) as RemarkRow[];
}

export function remarksToMap(rows: RemarkRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    out[row.name] = row.value;
  }
  return out;
}
