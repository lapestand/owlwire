import type { Fn } from '@owlwire/adapter-sdk';
import { errorName, scrubQueryParams, withholdEchoedInput } from '@owlwire/core';
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

/** Bound for the structural walk over log objects, error fields and `cause` chains. */
const MAX_DEPTH = 8;
/** DrizzleQueryError `params` and pg error fields that can carry row values, hints or SQL with literals (I-6). */
const DROPPED_ERROR_FIELDS = new Set(['params', 'detail', 'hint', 'where', 'internalQuery']);
/** Keys whose values are treated as errors: their plain-object values lose DROPPED_ERROR_FIELDS too. */
const ERROR_KEYS = new Set(['err', 'error', 'cause']);
const FRAME = /^\s+at /;
/**
 * Copies produced by sanitize. The logMethod hook sanitizes first and pino's serializers then see the copy; walking it
 * again would cut a rebuilt stack at its `params: [redacted]` line and lose the frames.
 */
const SANITIZED = new WeakSet<object>();

/** Loglanabilir hata mesajı: sorgu parametreleri atılır, girdi yankılayan mesajlar (SyntaxError, pg 22xxx, P0001) kesilir. */
function loggableMessage(err: Error): string {
  return withholdEchoedInput(err, scrubQueryParams(err.message));
}

/**
 * Özgün yığının çerçeveleri: mesaj başlığından (`<name>: <message>`, ya da mesajın satır sayısı kadar satır) sonraki
 * `    at ` satırları. Mesaj metni çerçeve için taranmaz.
 */
function stackFrames(err: Error): string[] {
  if (typeof err.stack !== 'string') return [];
  const header = err.message ? `${err.name}: ${err.message}` : err.name;
  const rest = err.stack.startsWith(header)
    ? err.stack.slice(header.length).split('\n').slice(1)
    : err.stack.split('\n').slice(err.message.split('\n').length);
  return rest.filter((line) => FRAME.test(line));
}

/**
 * Plain-text form of an error for places without a logger (the CLI fatal handler): `<name>: <message>` with the query
 * params cut and echoed input withheld, the original frames only (never lines from the message), then the same for
 * each Error in the `cause` chain. Non-Error values give a fixed text.
 */
export function safeErrorText(err: unknown): string {
  if (!(err instanceof Error)) return 'unknown error';
  const lines: string[] = [];
  const seen = new Set<Error>();
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && !seen.has(cur) && depth < MAX_DEPTH; depth++) {
    seen.add(cur);
    lines.push(`${depth === 0 ? '' : 'caused by: '}${errorName(cur)}: ${loggableMessage(cur)}`);
    lines.push(...stackFrames(cur));
    cur = cur.cause;
  }
  return lines.join('\n');
}

function serializeError(err: Error, depth: number, path: Set<object>): Record<string, unknown> {
  const type = errorName(err);
  const message = loggableMessage(err);
  const out: Record<string, unknown> = { type, message };
  if (typeof err.stack === 'string')
    out.stack = [`${type}: ${message}`, ...stackFrames(err)].join('\n');
  for (const [key, value] of Object.entries(err)) {
    if (DROPPED_ERROR_FIELDS.has(key) || key === 'cause' || key in out) continue;
    out[key] = sanitize(value, depth + 1, path, true);
  }
  if (err.cause !== undefined) out.cause = sanitize(err.cause, depth + 1, path, true);
  return out;
}

/**
 * Log değerinin sınırlı derinlikte, döngü güvenli kopyası: her Error (hangi anahtarda ve ne kadar içte olursa olsun)
 * güvenli biçimde seri hâle gelir, her string scrubQueryParams'tan geçer; hata bağlamındaki düz nesnelerden
 * (`err`/`error`/`cause` altı, hata alanları) DROPPED_ERROR_FIELDS atılır. Düz olmayan nesneler (Date, Buffer…) aynen kalır.
 */
function sanitize(
  value: unknown,
  depth: number,
  path: Set<object>,
  errorContext: boolean,
): unknown {
  if (typeof value === 'string') return scrubQueryParams(value);
  if (typeof value !== 'object' || value === null || SANITIZED.has(value)) return value;
  const isError = value instanceof Error;
  const proto = Object.getPrototypeOf(value);
  if (!isError && !Array.isArray(value) && proto !== Object.prototype && proto !== null)
    return value;
  if (path.has(value)) return '[Circular]';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  path.add(value);
  try {
    let out: object;
    if (isError) out = serializeError(value, depth, path);
    else if (Array.isArray(value))
      out = value.map((v) => sanitize(v, depth + 1, path, errorContext));
    else {
      const copy: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value)) {
        if (errorContext && DROPPED_ERROR_FIELDS.has(key)) continue;
        copy[key] = sanitize(v, depth + 1, path, errorContext || ERROR_KEYS.has(key));
      }
      out = copy;
    }
    SANITIZED.add(out);
    return out;
  } finally {
    path.delete(value);
  }
}

/**
 * pino `err`/`error` serializer'ı: `type`, `message`, `stack` (temizlenmiş başlık + özgün çerçeveler), kendi alanları
 * (DROPPED_ERROR_FIELDS hariç) ve `cause` zinciri; Error olmayan değerler de hata bağlamında temizlenir (I-6).
 */
export function serializeErr(err: unknown): unknown {
  return sanitize(err, 0, new Set(), true);
}

/** `%s`/`%o` ile biçimlenen argümanlar: Error güvenli metne, string ve nesneler temizlenmiş kopyaya döner. */
function interpolationArg(arg: unknown): unknown {
  if (arg instanceof Error) return `${errorName(arg)}: ${loggableMessage(arg)}`;
  return sanitize(arg, 0, new Set(), false);
}

/**
 * pino logMethod kancası (I-6): ilk argüman nesneyse yapısal olarak temizlenir (her anahtardaki Error ve string);
 * mesaj verilmezse pino `msg`'yi ham err.message'tan türeteceği için (pino 10 lib/proto.js) temizlenmiş mesaj verilir;
 * biçim argümanları (`%s`) da temizlenir.
 */
function scrubLogArgs(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
  const list: unknown[] = [...args];
  const first = list[0];
  if (typeof first === 'object' && first !== null) {
    const err =
      first instanceof Error
        ? first
        : (first as { err?: unknown }).err instanceof Error
          ? (first as { err: Error }).err
          : undefined;
    list[0] =
      first instanceof Error ? { err: serializeErr(first) } : sanitize(first, 0, new Set(), false);
    if (err && (list.length === 1 || list[1] === undefined)) list[1] = loggableMessage(err);
  }
  const out = list.map((a, i) => (i === 0 && typeof a !== 'string' ? a : interpolationArg(a)));
  method.apply(this, out as Parameters<LogFn>);
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
