import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

export type SqliteDatabase = Database.Database;

let singleton: SqliteDatabase | undefined;

function configure(db: SqliteDatabase): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

function ensureMigrationsTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
}

function appliedMigrations(db: SqliteDatabase): Set<string> {
  const rows = db.prepare('SELECT id FROM schema_migrations').all() as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

export function runMigrations(db: SqliteDatabase, migrationsDir = MIGRATIONS_DIR): string[] {
  ensureMigrationsTable(db);
  const applied = appliedMigrations(db);
  const files = readdirSync(migrationsDir)
    .filter((name) => /^\d+_.*\.sql$/.test(name))
    .sort((a, b) => a.localeCompare(b));

  const appliedNow: string[] = [];
  const insert = db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)');

  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = readFileSync(join(migrationsDir, file), 'utf8');
    const apply = db.transaction(() => {
      db.exec(sql);
      insert.run(file, Math.floor(Date.now() / 1000));
    });
    apply();
    appliedNow.push(file);
  }

  return appliedNow;
}

function preparePath(dbPath: string): void {
  if (dbPath === ':memory:') {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
}

export function openDatabase(dbPath: string): SqliteDatabase {
  preparePath(dbPath);
  const db = new Database(dbPath);
  configure(db);
  runMigrations(db);
  return db;
}

export function createDbSingleton(dbPath: string): SqliteDatabase {
  if (singleton) {
    return singleton;
  }
  singleton = openDatabase(dbPath);
  return singleton;
}

export function getDb(): SqliteDatabase {
  if (!singleton) {
    throw new Error('Database has not been opened');
  }
  return singleton;
}

export function closeDatabase(db?: SqliteDatabase): void {
  const target = db ?? singleton;
  if (!target) {
    return;
  }
  target.close();
  if (target === singleton) {
    singleton = undefined;
  }
}
