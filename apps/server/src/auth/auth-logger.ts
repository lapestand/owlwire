import type { Logger } from 'pino';

/** Better Auth's log levels (its `success` level is never passed to a custom `log`). */
export type AuthLogLevel = 'debug' | 'info' | 'warn' | 'error';

const EMAIL = /[^\s@<>()[\]"',;:]+@[^\s@<>()[\]"',;:]+\.[^\s@<>()[\]"',;:]+/g;
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const MAX_DEPTH = 4;

/**
 * Better Auth writes some values straight into its messages ("Invalid callbackURL: <url>", the email of a duplicate
 * sign-up). URLs can carry reset or verification tokens and emails are personal data, so both are replaced.
 */
export function redactAuthText(text: string): string {
  return text.replace(URL_PATTERN, '[url]').replace(EMAIL, '[email]');
}

/** Strings redacted, errors left for pino's err serializer (it drops query params and row values). */
function scrub(value: unknown, depth: number): unknown {
  if (typeof value === 'string') return redactAuthText(value);
  if (typeof value !== 'object' || value === null || value instanceof Error) return value;
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null)
    return `[${proto?.constructor?.name ?? 'object'}]`;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, depth + 1)]));
}

/**
 * Better Auth's `logger` option, routed through our pino logger. Its default console logger printed failed queries
 * with their parameters (emails included). Here the message and the extra arguments are redacted, Errors go under
 * `err` so the pino serializer scrubs them, and info and debug messages are dropped: several of them name the user.
 */
export function betterAuthLogger(logger: Logger): {
  level: 'warn';
  log: (level: AuthLogLevel, message: string, ...args: unknown[]) => void;
} {
  const log = logger.child({ component: 'auth' });
  return {
    level: 'warn',
    log: (level, message, ...args) => {
      if (level !== 'warn' && level !== 'error') return;
      const err = args.find((a): a is Error => a instanceof Error);
      const details = args.filter((a) => !(a instanceof Error)).map((a) => scrub(a, 0));
      log[level](
        { ...(err ? { err } : {}), ...(details.length > 0 ? { details } : {}) },
        redactAuthText(message),
      );
    },
  };
}
