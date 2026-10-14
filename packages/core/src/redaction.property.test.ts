import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { cutQueryParams, scrubQueryParams, withholdEchoedInput } from './redaction.js';

/** A secret that cannot occur by chance in the generated surrounding text (which never contains `~`). */
const secret = fc
  .string({
    unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-'),
    minLength: 6,
    maxLength: 24,
  })
  .map((s) => `~${s}~`);

/** Text free of the secret marker: SQL, messages, anything but `~`. */
const plain = fc.string({ unit: 'binary', maxLength: 80 }).map((s) => s.replaceAll('~', ''));

/** A stack-frame-looking line, which must not survive just because it starts with `at `. */
const frameLine = fc
  .tuple(fc.constantFrom('    at ', 'at ', '\tat ', '  at '), plain)
  .map(([prefix, rest]) => prefix + rest);

/**
 * One parameter value that contains the secret, possibly spread over several lines, with stack-frame-looking lines
 * and arbitrary text around it.
 */
const secretParam = fc
  .tuple(secret, fc.array(fc.oneof(plain, frameLine), { maxLength: 4 }), fc.nat())
  .map(([s, lines, at]) => {
    const all = [...lines];
    all.splice(at % (all.length + 1), 0, `${s}`);
    return all.join('\n');
  });

/** Drizzle's `Failed query: <sql>\nparams: <values>` text with the secret somewhere in the values. */
const failedQuery = fc
  .record({
    sql: plain,
    indent: fc.constantFrom('', ' ', '  ', '\t'),
    before: fc.array(plain, { maxLength: 3 }),
    value: secretParam,
    after: fc.array(fc.oneof(plain, frameLine), { maxLength: 3 }),
    newline: fc.constantFrom('\n', '\r\n'),
  })
  .map(({ sql, indent, before, value, after, newline }) => ({
    text: `Failed query: ${sql}${newline}${indent}params: ${[...before, value, ...after].join(',')}`,
  }));

const secretOf = (text: string) => /~[^~]*~/.exec(text)?.[0] ?? '';

describe('query param redaction properties', () => {
  it('never lets a secret query param through scrubQueryParams or cutQueryParams', () => {
    fc.assert(
      fc.property(failedQuery, ({ text }) => {
        const s = secretOf(text);
        expect(s).not.toBe('');
        expect(scrubQueryParams(text)).not.toContain(s);
        expect(cutQueryParams(text)).not.toContain(s);
        expect(scrubQueryParams(text)).toMatch(/\nparams: \[redacted\]$/);
      }),
    );
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          failedQuery.map((q) => q.text),
          plain,
        ),
        (text) => {
          const once = scrubQueryParams(text);
          expect(scrubQueryParams(once)).toBe(once);
        },
      ),
    );
  });
});

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

/** Errors whose message echoes input, optionally wrapped in a cause chain the way Drizzle and the repos do. */
const echoingError = fc
  .record({
    s: secret,
    lead: plain.map((t) => t.replace(/["']/g, '')),
    quote: fc.constantFrom('"', "'"),
    tail: plain,
    kind: fc.constantFrom('syntax', '22P02', '22007', '22001', 'P0001'),
    wrappers: fc.nat({ max: 4 }),
  })
  .map(({ s, lead, quote, tail, kind, wrappers }) => {
    const message = `${lead}${quote}${s}${quote}${tail}`;
    let err: Error = kind === 'syntax' ? new SyntaxError(message) : pgError(kind, message);
    for (let i = 0; i < wrappers; i++) {
      err = new Error(`wrapper ${i}: ${err.message}`, { cause: err });
    }
    return { err, s };
  });

describe('withholdEchoedInput properties', () => {
  it('never returns an echoed secret, however deep the echoing error sits in the cause chain', () => {
    fc.assert(
      fc.property(echoingError, ({ err, s }) => {
        expect(withholdEchoedInput(err, err.message)).not.toContain(s);
        expect(withholdEchoedInput(err, scrubQueryParams(err.message))).not.toContain(s);
      }),
    );
  });

  it('withholds what JSON.parse echoes back from an invalid secret document', () => {
    fc.assert(
      fc.property(secret, plain, plain, (s, before, after) => {
        const doc = `${before}${s}${after}`;
        let parseError: unknown;
        try {
          JSON.parse(doc);
        } catch (err) {
          parseError = err;
        }
        fc.pre(parseError instanceof SyntaxError);
        expect(withholdEchoedInput(parseError, (parseError as Error).message)).not.toContain(s);
      }),
    );
  });
});
