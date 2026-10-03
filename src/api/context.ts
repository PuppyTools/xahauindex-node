import type { Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: SqliteDatabase;
    config: Config;
    startedAt: number;
    networkLedgerIndex: number | null;
  }
}

export interface AppContext {
  db: SqliteDatabase;
  config: Config;
  startedAt: number;
  networkLedgerIndex: number | null;
}
