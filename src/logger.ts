import pino, { type Logger } from 'pino';

import type { LogLevel } from './config.js';

export function createLogger(level: LogLevel): Logger {
  return pino({ level });
}
