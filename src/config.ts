import { config as loadDotenv } from 'dotenv';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  xahaudUrl: string;
  dbPath: string;
  apiPort: number;
  apiHost: string;
  logLevel: LogLevel;
  /** Absolute ledger to start historical backfill, or null to skip. `1` is genesis. */
  backfillFromLedger: number | null;
  /** If `backfillFromLedger` is unset, start at `snapshot - lookback + 1`. */
  backfillLookback: number | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  return raw.trim();
}

function readPort(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new ConfigError(`${key} must be an integer between 1 and 65535`);
  }
  return value;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = readString(env, 'LOG_LEVEL', 'info');
  if ((LOG_LEVELS as readonly string[]).includes(raw)) {
    return raw as LogLevel;
  }
  throw new ConfigError(`LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}`);
}

function readWebsocketUrl(env: NodeJS.ProcessEnv): string {
  const url = readString(env, 'XAHAUD_URL', 'wss://xahau.network');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConfigError('XAHAUD_URL must be a valid WebSocket URL');
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new ConfigError('XAHAUD_URL must use ws:// or wss://');
  }
  return url;
}

function readOptionalPositiveInt(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${key} must be an integer >= 1`);
  }
  return value;
}

function readBackfillFromLedger(env: NodeJS.ProcessEnv): number | null {
  const raw = env.BACKFILL_FROM_LEDGER ?? env.FULL_HISTORY_START;
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'genesis' || trimmed === 'start') {
    return 1;
  }
  const value = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError('BACKFILL_FROM_LEDGER must be an integer >= 1, or "genesis"');
  }
  return value;
}

export function resolveBackfillFrom(config: Config, snapshotLedger: number): number | null {
  if (!Number.isInteger(snapshotLedger) || snapshotLedger < 1) {
    return null;
  }
  if (config.backfillFromLedger !== null) {
    return Math.min(snapshotLedger, config.backfillFromLedger);
  }
  if (config.backfillLookback !== null) {
    return Math.max(1, snapshotLedger - config.backfillLookback + 1);
  }
  return null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    xahaudUrl: readWebsocketUrl(env),
    dbPath: readString(env, 'DB_PATH', './data/xahauindex.db'),
    apiPort: readPort(env, 'API_PORT', 3000),
    apiHost: readString(env, 'API_HOST', '0.0.0.0'),
    logLevel: readLogLevel(env),
    backfillFromLedger: readBackfillFromLedger(env),
    backfillLookback: readOptionalPositiveInt(env, 'BACKFILL_LOOKBACK'),
  };
}

export function initEnv(envPath?: string): void {
  loadDotenv(envPath === undefined ? undefined : { path: envPath });
}
