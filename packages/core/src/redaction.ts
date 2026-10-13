const SQLSTATE = /^[0-9A-Z]{5}$/;
/** How far the `cause` chain is followed (Drizzle and the repositories wrap the pg error once or twice). */
const MAX_CAUSE_DEPTH = 5;

/**
 * Errors whose message echoes input values: JSON.parse's SyntaxError (it quotes the text, e.g. a decrypted config),
 * PostgreSQL data exceptions (SQLSTATE class 22, e.g. `invalid input syntax for type uuid: "<value>"`) and
 * PL/pgSQL `RAISE` (P0001, free text). Checked along the `cause` chain, because wrappers copy the inner message.
 */
function echoesInput(err: unknown): boolean {
  let cur: unknown = err;
  for (
    let depth = 0;
    depth <= MAX_CAUSE_DEPTH && typeof cur === 'object' && cur !== null;
    depth++
  ) {
    if (cur instanceof SyntaxError) return true;
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE.test(code)) {
      if (code.startsWith('22') || code === 'P0001') return true;
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * I-6: when `err` (or any error in its `cause` chain) echoes input, `text` is cut at its first quote (`"` or `'`)
 * and `[redacted]` is appended; values are echoed in quotes, so only the fixed reason remains. Otherwise `text` is
 * returned unchanged. Fails safe: it may over-redact, never under-redact quoted values.
 */
export function withholdEchoedInput(err: unknown, text: string): string {
  if (!echoesInput(err)) return text;
  const quote = text.search(/["']/);
  return quote === -1 ? text : `${text.slice(0, quote)}[redacted]`;
}

/** Start of Drizzle's `params:` block in `Failed query: <sql>\nparams: <values>` (leading indentation allowed). */
const QUERY_PARAMS_MARKER = /\n[ \t]*params:/;

/**
 * I-6: the text before the first `params:` line. Everything from the marker to the end is dropped: parameter values
 * can span lines and those lines can start with `at `, so the cut never looks for stack frames.
 */
export function cutQueryParams(text: string): string {
  const m = QUERY_PARAMS_MARKER.exec(text);
  return m ? text.slice(0, m.index) : text;
}

/** Like {@link cutQueryParams}, but leaves a `params: [redacted]` marker where the values were. */
export function scrubQueryParams(text: string): string {
  const cut = cutQueryParams(text);
  return cut === text ? text : `${cut}\nparams: [redacted]`;
}

/**
 * Display name of an error: its `name` unless that is the generic `Error`, else its constructor's name (drizzle-orm
 * does not set `name` on DrizzleQueryError).
 */
export function errorName(err: Error): string {
  if (err.name && err.name !== 'Error') return err.name;
  return err.constructor?.name || 'Error';
}
