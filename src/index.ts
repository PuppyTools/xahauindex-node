import { buildApi } from './api/index.js';
import { initEnv, loadConfig } from './config.js';
import { closeDatabase, openDatabase } from './db/client.js';
import { startIngester } from './ingester/index.js';
import { createLogger } from './logger.js';
import { createRuntime } from './runtime.js';

initEnv();

const config = loadConfig();
const log = createLogger(config.logLevel);
const db = openDatabase(config.dbPath);
const runtime = createRuntime();

const app = await buildApi(
  {
    db,
    config,
    runtime,
  },
  config.logLevel,
);

const controller = new AbortController();

const ingester = startIngester({
  db,
  config,
  runtime,
  log,
  signal: controller.signal,
}).catch((error: unknown) => {
  log.error({ err: error }, 'ingester failed');
});

const shutdown = async (signal: string): Promise<void> => {
  log.info({ signal }, 'shutting down');
  controller.abort();
  await ingester;
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
