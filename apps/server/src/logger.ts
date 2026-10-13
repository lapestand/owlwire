import type { Fn } from '@owlwire/adapter-sdk';
import { type DestinationStream, type Logger, pino } from 'pino';

export const REDACT_PATHS = [
  'token',
  'config',
  'password',
  'secret',
  'botToken',
  'cookie',
  'authorization',
  '*.token',
  '*.config',
  '*.password',
  '*.secret',
  '*.botToken',
  '*.cookie',
  '*.authorization',
];

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'owlwire' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  };
  return destination ? pino(options, destination) : pino(options);
}

export function toAdapterLogger(logger: Logger): { info: Fn; warn: Fn; error: Fn; debug: Fn } {
  const wrap =
    (level: 'info' | 'warn' | 'error' | 'debug'): Fn =>
    (objOrMsg, msg) => {
      if (typeof objOrMsg === 'string') logger[level](objOrMsg);
      else logger[level](objOrMsg as object, msg);
    };
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug') };
}
