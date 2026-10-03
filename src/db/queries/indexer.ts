import type { SqliteDatabase } from '../client.js';

export function getIndexerState(db: SqliteDatabase, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM indexer_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setIndexerState(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    `
    INSERT INTO indexer_state (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `,
  ).run(key, value);
}

export function getLatestLedgerIndex(db: SqliteDatabase): number {
  const row = db.prepare('SELECT MAX(ledger_index) AS i FROM ledgers').get() as
    | { i: number | null }
    | undefined;
  return row?.i ?? 0;
}

export function getIndexedLedgerCount(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number };
  return row.n;
}

export function getTokenCount(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM tokens').get() as { n: number };
  return row.n;
}

export function getUriTokenCount(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM uri_tokens').get() as { n: number };
  return row.n;
}

export function getIssuerCount(db: SqliteDatabase): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM issuers').get() as { n: number };
  return row.n;
}
