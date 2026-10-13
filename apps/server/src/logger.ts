import type { Fn } from '@owlwire/adapter-sdk';
import { withholdEchoedInput } from '@owlwire/db';
import { type DestinationStream, type LogFn, type Logger, pino } from 'pino';

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

const PARAMS_SEGMENT = /\n[ \t]*params:[\s\S]*?(?=\n[ \t]*at |$)/g;
const MAX_CAUSE_DEPTH = 5;
/** DrizzleQueryError `params` and pg error fields that can carry row values or SQL with literals (I-6). */
const DROPPED_ERROR_FIELDS = new Set(['params', 'detail', 'where', 'internalQuery']);

/**
 * I-6: Drizzle'ın `Failed query: <sql>\nparams: <değerler>` metnindeki değerleri atar. Kesim bir sonraki yığın
 * satırına (`\n    at `) ya da metnin sonuna kadardır; çok satırlı parametreler de gider.
 */
export function scrubQueryParams(text: string): string {
  return text.replace(PARAMS_SEGMENT, '\nparams: [redacted]');
}

/** Loglanabilir hata mesajı: sorgu parametreleri atılır, girdi yankılayan mesajlar (SyntaxError, pg 22xxx) kesilir. */
function loggableMessage(err: Error): string {
  return withholdEchoedInput(err, scrubQueryParams(err.message));
}

/**
 * Yığının başlığı mesajı tekrar eder. Girdi yankılayan hatalarda başlık temizlenmiş mesajla yeniden kurulur ve
 * yalnız çerçeve satırları (`    at `) tutulur; diğerlerinde yığın scrubQueryParams'tan geçer.
 */
function loggableStack(err: Error, type: string, message: string): string | undefined {
  if (err.stack === undefined) return undefined;
  const scrubbed = scrubQueryParams(err.stack);
  if (withholdEchoedInput(err, err.message) === err.message) return scrubbed;
  const frames = scrubbed.split('\n').filter((line) => /^\s+at /.test(line));
  return [`${type}: ${message}`, ...frames].join('\n');
}

/**
 * pino `err` serializer'ı: `type`, `message`, `stack`, kendi alanları (`params`, `detail`, `where`, `internalQuery`
 * hariç) ve `cause` zinciri (en çok 5); metinler scrubQueryParams'tan geçer (I-6).
 */
export function serializeErr(err: unknown, depth = 0): unknown {
  if (typeof err === 'string') return scrubQueryParams(err);
  if (!(err instanceof Error)) return err;
  const type = err.constructor.name === 'Error' ? err.name : err.constructor.name;
  const message = loggableMessage(err);
  const out: Record<string, unknown> = { type, message, stack: loggableStack(err, type, message) };
  for (const [key, value] of Object.entries(err)) {
    if (DROPPED_ERROR_FIELDS.has(key) || key === 'cause' || key in out) continue;
    out[key] = typeof value === 'string' ? scrubQueryParams(value) : value;
  }
  if (err.cause !== undefined && depth < MAX_CAUSE_DEPTH) {
    out.cause = serializeErr(err.cause, depth + 1);
  }
  return out;
}

/**
 * pino logMethod kancası: mesaj verilmezse pino `msg`'yi ham err.message'tan türetir (pino 10 lib/proto.js);
 * burada mesaj temizlenmiş metinle verilir ve her string argüman scrubQueryParams'tan geçer.
 */
function scrubLogArgs(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
  const list: unknown[] = [...args];
  const first = list[0];
  const err =
    first instanceof Error
      ? first
      : typeof first === 'object' &&
          first !== null &&
          (first as { err?: unknown }).err instanceof Error
        ? (first as { err: Error }).err
        : undefined;
  if (err && (list.length === 1 || list[1] === undefined)) list[1] = loggableMessage(err);
  method.apply(
    this,
    list.map((a) => (typeof a === 'string' ? scrubQueryParams(a) : a)) as Parameters<LogFn>,
  );
}

export function createLogger(level: string, destination?: DestinationStream): Logger {
  const options = {
    level,
    base: { service: 'owlwire' },
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // `error` too: an Error logged under that key would otherwise be stringified with its enumerable `params`.
    serializers: { err: serializeErr, error: serializeErr },
    hooks: { logMethod: scrubLogArgs },
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
