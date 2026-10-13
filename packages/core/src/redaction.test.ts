import { describe, expect, it } from 'vitest';
import { withholdEchoedInput } from './redaction.js';

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
