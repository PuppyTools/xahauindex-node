import type { SqliteDatabase } from '../client.js';

import type { LedgerRow } from '../../types/db.js';

export function upsertLedger(db: SqliteDatabase, row: LedgerRow): void {
  db.prepare(
    `
    INSERT INTO ledgers (ledger_index, close_time, hash, tx_count, indexed_at)
    VALUES (@ledger_index, @close_time, @hash, @tx_count, @indexed_at)
    ON CONFLICT(ledger_index) DO UPDATE SET
      close_time = excluded.close_time,
      hash = excluded.hash,
      tx_count = excluded.tx_count,
      indexed_at = excluded.indexed_at
    `,
  ).run(row);
}

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

export function hasLedger(db: SqliteDatabase, ledgerIndex: number): boolean {
  const row = db.prepare('SELECT 1 AS ok FROM ledgers WHERE ledger_index = ?').get(ledgerIndex) as
    | { ok: number }
    | undefined;
  return row !== undefined;
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
