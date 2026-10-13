const SQLSTATE = /^[0-9A-Z]{5}$/;

/** Returns the Postgres SQLSTATE of an error, following Drizzle's `cause` wrapping. */
export function pgErrorCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5; depth++) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
