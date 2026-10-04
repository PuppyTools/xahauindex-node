import type { Config } from '../config.js';
import type { SqliteDatabase } from '../db/client.js';
import type { Runtime } from '../runtime.js';
import type { EventHub } from './hub.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: SqliteDatabase;
    config: Config;
    runtime: Runtime;
    hub: EventHub;
  }
}

export interface AppContext {
  db: SqliteDatabase;
  config: Config;
  runtime: Runtime;
  hub?: EventHub;
}
