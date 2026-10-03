import { config as loadDotenv } from 'dotenv';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Config {
  xahaudUrl: string;
  dbPath: string;
  apiPort: number;
  apiHost: string;
  logLevel: LogLevel;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    xahaudUrl: readWebsocketUrl(env),
    dbPath: readString(env, 'DB_PATH', './data/xahauindex.db'),
    apiPort: readPort(env, 'API_PORT', 3000),
    apiHost: readString(env, 'API_HOST', '0.0.0.0'),
    logLevel: readLogLevel(env),
  };
}

export function initEnv(envPath?: string): void {
  loadDotenv(envPath === undefined ? undefined : { path: envPath });
}
