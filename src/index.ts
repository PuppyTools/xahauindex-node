import { buildApi } from './api/index.js';
import { initEnv, loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/client.js';
import { createLogger } from './logger.js';

initEnv();

const config = loadConfig();
const log = createLogger(config.logLevel);
const db = openDatabase(config.dbPath);
const startedAt = Date.now();

const app = await buildApi(
  {
    db,
    config,
    startedAt,
    networkLedgerIndex: null,
  },
  config.logLevel,
);

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  await app.close();
  closeDatabase(db);
  process.exit(0);
};

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

await app.listen({ port: config.apiPort, host: config.apiHost });
log.info(
  { host: config.apiHost, port: config.apiPort, dbPath: config.dbPath },
  'xahauindex listening',
);
