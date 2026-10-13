import { describe, expect, it } from 'vitest';
import { cutQueryParams, errorName, scrubQueryParams, withholdEchoedInput } from './redaction.js';

const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });

describe('withholdEchoedInput', () => {
  it('cuts the text of input-echoing errors at the first quote', () => {
    let parseError: unknown;
    try {
      JSON.parse('bot123:SECRET-JSON');
    } catch (err) {
      parseError = err;
    }
    expect(withholdEchoedInput(parseError, (parseError as Error).message)).toBe(
      'Unexpected token [redacted]',
    );
    const data = pgErr('22P02', 'invalid input syntax for type uuid: "SECRET"');
    expect(withholdEchoedInput(data, data.message)).toBe(
      'invalid input syntax for type uuid: [redacted]',
    );
    const raised = pgErr('P0001', "approval for 'SECRET' refused");
    expect(withholdEchoedInput(raised, raised.message)).toBe('approval for [redacted]');
  });

  it('masks a wrapper whose cause chain contains an echoing error', () => {
    const inner = new SyntaxError('Unexpected token \'b\', "bot123:SECRET" is not valid JSON');
    const outer = new Error(`config parse failed: ${inner.message}`, { cause: inner });
    expect(withholdEchoedInput(outer, outer.message)).toBe(
      'config parse failed: Unexpected token [redacted]',
    );
    const deep = new Error('x "SECRET"', {
      cause: new Error('y', { cause: pgErr('22007', 'invalid datetime "SECRET"') }),
    });
    expect(withholdEchoedInput(deep, deep.message)).toBe('x [redacted]');
  });

  it('keeps other errors and quote-free texts verbatim', () => {
    const unique = pgErr('23505', 'duplicate key value violates unique constraint "x_uq"');
    expect(withholdEchoedInput(unique, unique.message)).toBe(unique.message);
    const eof = new SyntaxError('Unexpected end of JSON input');
    expect(withholdEchoedInput(eof, eof.message)).toBe(eof.message);
    expect(withholdEchoedInput('not an error', 'a "b"')).toBe('a "b"');
  });
});

describe('query params scrubbing', () => {
  const text = 'Failed query: select $1\n  params: SECRET\n    at fake (x.js:1:1) SECRET-2';

  it('cuts everything from the first params marker, frames-looking lines included', () => {
    expect(cutQueryParams(text)).toBe('Failed query: select $1');
    expect(scrubQueryParams(text)).toBe('Failed query: select $1\nparams: [redacted]');
  });

  it('leaves text without a params marker unchanged', () => {
    expect(cutQueryParams('no params here')).toBe('no params here');
    expect(scrubQueryParams('params: inline only')).toBe('params: inline only');
  });
});

describe('errorName', () => {
  it('prefers a specific name and falls back to the constructor name', () => {
    class DriverError extends Error {}
    expect(errorName(new TypeError('x'))).toBe('TypeError');
    expect(errorName(new DriverError('x'))).toBe('DriverError');
    expect(errorName(Object.assign(new Error('x'), { name: 'Named' }))).toBe('Named');
    expect(errorName(new Error('x'))).toBe('Error');
  });
});
