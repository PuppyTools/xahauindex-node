import { existsSync, readFileSync } from 'node:fs';

import { config as loadDotenv, parse as parseDotenv } from 'dotenv';

import { parseIpAllowlist } from './util/allowlist.js';

export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_BACKFILL_ENV = '.env.backfill';

export interface Config {
  xahaudUrl: string;
  dbPath: string;
  apiPort: number;
  apiHost: string;
  /**
   * Public origin shown in `/docs` cookbook curls, Open links, and the served
   * OpenAPI `servers` URL. Listen address is still `apiHost`/`apiPort`.
   */
  apiBaseUrl: string;
  logLevel: LogLevel;
  /** Earliest ledger the historical walk stops at, or null to skip. `1` is genesis. */
  backfillFromLedger: number | null;
  /** If `backfillFromLedger` is unset, stop at `snapshot - lookback + 1`. */
  backfillLookback: number | null;
  /**
   * Dedicated history node for the live gap fill and backward backfill
   * (`ws`/`wss` or `http`/`https` JSON-RPC). Null means reuse `xahaudUrl`.
   */
  backfillXahaudUrl: string | null;
  /** Second env file that supplied the backfill node URL, if any. */
  backfillEnvPath: string | null;
  /**
   * Minimum delay between historical ledger fetches. `null` = 2000ms when sharing
   * the live node, 0 when using a dedicated backfill URL.
   */
  backfillMinIntervalMs: number | null;
  /** HTTP requests per IP per window. `null` / `0` leaves the API unlimited. */
  apiRateLimitMax: number | null;
  /** Rate-limit window in milliseconds. */
  apiRateLimitWindowMs: number;
  /** Trust `X-Forwarded-For` only when a reverse proxy is in front. */
  apiTrustProxy: boolean;
  /** IPs / CIDRs that skip the HTTP limiter. */
  apiRateLimitAllow: string[];
  /**
   * Concurrent `/v1/subscribe` sockets per IP. `null` inherits `8` when the
   * HTTP limiter is on, or no cap when it is off. `0` disables the cap.
   */
  apiWsMaxPerIp: number | null;
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

function parseUrl(raw: string, key: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new ConfigError(`${key} must be a valid URL`);
  }
}

function readWebsocketUrl(env: NodeJS.ProcessEnv): string {
  const url = readString(env, 'XAHAUD_URL', 'wss://xahau.network');
  const parsed = parseUrl(url, 'XAHAUD_URL');
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new ConfigError('XAHAUD_URL must use ws:// or wss://');
  }
  return url;
}

function readBackfillNodeUrl(raw: string, key: string): string {
  const parsed = parseUrl(raw, key);
  if (
    parsed.protocol !== 'ws:' &&
    parsed.protocol !== 'wss:' &&
    parsed.protocol !== 'http:' &&
    parsed.protocol !== 'https:'
  ) {
    throw new ConfigError(`${key} must use ws://, wss://, http://, or https://`);
  }
  return raw;
}

function readBackfillEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) {
    throw new ConfigError(`BACKFILL_ENV file not found: ${path}`);
  }
  return parseDotenv(readFileSync(path, 'utf8'));
}

function resolveBackfillEnvPath(env: NodeJS.ProcessEnv): string | null {
  const raw = env.BACKFILL_ENV;
  if (raw !== undefined && raw.trim() !== '') {
    return raw.trim();
  }
  if (env === process.env && existsSync(DEFAULT_BACKFILL_ENV)) {
    return DEFAULT_BACKFILL_ENV;
  }
  return null;
}

function readBackfillNode(env: NodeJS.ProcessEnv): {
  backfillXahaudUrl: string | null;
  backfillEnvPath: string | null;
} {
  const direct = env.BACKFILL_XAHAUD_URL;
  if (direct !== undefined && direct.trim() !== '') {
    return {
      backfillXahaudUrl: readBackfillNodeUrl(direct.trim(), 'BACKFILL_XAHAUD_URL'),
      backfillEnvPath: null,
    };
  }
  const envPath = resolveBackfillEnvPath(env);
  if (envPath === null) {
    return { backfillXahaudUrl: null, backfillEnvPath: null };
  }
  const fileEnv = readBackfillEnvFile(envPath);
  const fromFile = fileEnv.BACKFILL_XAHAUD_URL ?? fileEnv.XAHAUD_URL;
  if (fromFile === undefined || fromFile.trim() === '') {
    return { backfillXahaudUrl: null, backfillEnvPath: envPath };
  }
  return {
    backfillXahaudUrl: readBackfillNodeUrl(fromFile.trim(), 'BACKFILL_XAHAUD_URL'),
    backfillEnvPath: envPath,
  };
}

function readOptionalNonNegativeInt(env: NodeJS.ProcessEnv, key: string): number | null {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return null;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigError(`${key} must be an integer >= 0`);
  }
  return value;
}

export const SHARED_BACKFILL_INTERVAL_MS = 2_000;
export const DEFAULT_API_RATE_LIMIT_WINDOW_MS = 60_000;
export const DEFAULT_WS_MAX_PER_IP = 8;
export const DEFAULT_API_BASE_URL = 'http://localhost:3000';

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

function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  throw new ConfigError(`${key} must be true, false, 1, 0, yes, or no`);
}

function readRateLimitMax(env: NodeJS.ProcessEnv): number | null {
  const value = readOptionalNonNegativeInt(env, 'API_RATE_LIMIT_MAX');
  if (value === null || value === 0) {
    return null;
  }
  return value;
}

function readRateLimitWindowMs(env: NodeJS.ProcessEnv): number {
  return readOptionalPositiveInt(env, 'API_RATE_LIMIT_WINDOW_MS') ?? DEFAULT_API_RATE_LIMIT_WINDOW_MS;
}

function readRateLimitAllow(env: NodeJS.ProcessEnv): string[] {
  const raw = env.API_RATE_LIMIT_ALLOW;
  if (raw === undefined || raw.trim() === '') {
    return [];
  }
  try {
    return parseIpAllowlist(raw);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : 'API_RATE_LIMIT_ALLOW is invalid');
  }
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

export function resolveBackfillSourceUrl(config: Config): string {
  return config.backfillXahaudUrl ?? config.xahaudUrl;
}

export function resolveBackfillMinIntervalMs(config: Config, dedicatedNode: boolean): number {
  if (config.backfillMinIntervalMs !== null) {
    return config.backfillMinIntervalMs;
  }
  return dedicatedNode ? 0 : SHARED_BACKFILL_INTERVAL_MS;
}

export function resolveGapFillMinIntervalMs(config: Config): number {
  if (config.backfillMinIntervalMs !== null) {
    return config.backfillMinIntervalMs;
  }
  return SHARED_BACKFILL_INTERVAL_MS;
}

export function resolveWsMaxPerIp(config: Config): number | null {
  if (config.apiWsMaxPerIp !== null) {
    return config.apiWsMaxPerIp === 0 ? null : config.apiWsMaxPerIp;
  }
  return config.apiRateLimitMax === null ? null : DEFAULT_WS_MAX_PER_IP;
}

export function resolveWsBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol === 'https:') {
    url.protocol = 'wss:';
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:';
  }
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.origin}${path === '/' ? '' : path}`;
}

export function rewriteDocsBaseUrl(text: string, baseUrl: string): string {
  return text
    .replaceAll(DEFAULT_API_BASE_URL, baseUrl)
    .replaceAll(resolveWsBaseUrl(DEFAULT_API_BASE_URL), resolveWsBaseUrl(baseUrl));
}

function readApiBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.API_BASE_URL;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_API_BASE_URL;
  }
  const trimmed = raw.trim().replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ConfigError('API_BASE_URL must be a valid http:// or https:// URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('API_BASE_URL must use http:// or https://');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigError('API_BASE_URL must not include credentials');
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new ConfigError('API_BASE_URL must not include a query or fragment');
  }
  if (parsed.hostname === '') {
    throw new ConfigError('API_BASE_URL must include a hostname');
  }
  return trimmed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const backfillNode = readBackfillNode(env);
  return {
    xahaudUrl: readWebsocketUrl(env),
    dbPath: readString(env, 'DB_PATH', './data/xahauindex.db'),
    apiPort: readPort(env, 'API_PORT', 3000),
    apiHost: readString(env, 'API_HOST', '0.0.0.0'),
    apiBaseUrl: readApiBaseUrl(env),
    logLevel: readLogLevel(env),
    backfillFromLedger: readBackfillFromLedger(env),
    backfillLookback: readOptionalPositiveInt(env, 'BACKFILL_LOOKBACK'),
    backfillXahaudUrl: backfillNode.backfillXahaudUrl,
    backfillEnvPath: backfillNode.backfillEnvPath,
    backfillMinIntervalMs: readOptionalNonNegativeInt(env, 'BACKFILL_MIN_INTERVAL_MS'),
    apiRateLimitMax: readRateLimitMax(env),
    apiRateLimitWindowMs: readRateLimitWindowMs(env),
    apiTrustProxy: readBoolean(env, 'API_TRUST_PROXY', false),
    apiRateLimitAllow: readRateLimitAllow(env),
    apiWsMaxPerIp: readOptionalNonNegativeInt(env, 'API_WS_MAX_PER_IP'),
  };
}

export function initEnv(envPath?: string): void {
  loadDotenv(envPath === undefined ? undefined : { path: envPath });
}
