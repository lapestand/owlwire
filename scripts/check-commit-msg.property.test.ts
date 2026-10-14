import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkCommitMessage, MAX_HEADER, TYPES } from './check-commit-msg.mjs';

// Words that the attribution and internal-reference rules reject on purpose; a generated "valid" message avoids them.
const RESERVED_WORDS = new Set([
  'claude',
  'anthropic',
  'chatgpt',
  'openai',
  'copilot',
  'generated',
  'sozlesme',
  'gorev',
]);

const lower = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz');
const word = fc
  .string({ unit: lower, minLength: 1, maxLength: 10 })
  .filter((w) => !RESERVED_WORDS.has(w));
const words = (max: number) =>
  fc.array(word, { minLength: 1, maxLength: max }).map((ws) => ws.join(' '));

const scope = fc
  .tuple(lower, fc.string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz._/-') }))
  .map(([first, rest]) => first + rest);

/** A conventional header that satisfies every rule: known type, optional scope and `!`, lowercase English words. */
const validHeader = fc
  .record({
    type: fc.constantFrom(...TYPES),
    scope: fc.option(scope, { nil: undefined }),
    breaking: fc.boolean(),
    description: words(12),
  })
  .map(
    ({ type, scope, breaking, description }) =>
      `${type}${scope === undefined ? '' : `(${scope})`}${breaking ? '!' : ''}: ${description}`,
  )
  .filter((header) => header.length <= MAX_HEADER);

const validBody = fc.array(words(12), { maxLength: 4 }).map((lines) => lines.join('\n'));

const validMessage = fc
  .tuple(validHeader, validBody)
  .map(([header, body]) => (body === '' ? header : `${header}\n\n${body}`));

/**
 * Any message shape a commit can carry: a valid conventional message, a header git writes itself (merge, revert,
 * fixup), or arbitrary text. Lines starting with `#` are excluded: git strips them as comments before the hook runs.
 */
const carrier = fc
  .oneof(
    validMessage,
    fc
      .tuple(
        fc.constantFrom(
          "Merge branch 'feature/x'",
          'Merge pull request #12 from owner/fix-y',
          'Revert "feat: add discord adapter"',
          'fixup! fix(db): close scoped transactions',
          'squash! docs: explain key rotation',
        ),
        validBody,
      )
      .map(([header, body]) => (body === '' ? header : `${header}\n\n${body}`)),
    fc.string({ unit: 'binary' }),
  )
  .filter((msg) => !msg.split(/\r?\n/).some((line) => line.startsWith('#')));

/** Inserts `fragment` at a generated position of `text`. */
const insertAt = (text: string, position: number, fragment: string) => {
  const at = position % (text.length + 1);
  return `${text.slice(0, at)}${fragment}${text.slice(at)}`;
};

/** Randomly upper- or lower-cases each character. */
const anyCase = (text: string) =>
  fc
    .array(fc.boolean(), { minLength: text.length, maxLength: text.length })
    .map((flags) =>
      [...text].map((c, i) => (flags[i] ? c.toUpperCase() : c.toLowerCase())).join(''),
    );

describe('checkCommitMessage properties', () => {
  it('never throws and always returns a list of strings', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (raw) => {
        const problems = checkCommitMessage(raw);
        expect(Array.isArray(problems)).toBe(true);
        for (const p of problems) expect(typeof p).toBe('string');
      }),
    );
  });

  it('accepts every valid generated message', () => {
    fc.assert(
      fc.property(validMessage, (msg) => {
        expect(checkCommitMessage(msg)).toEqual([]);
      }),
    );
  });

  it('rejects any message carrying a Co-authored-by line', () => {
    fc.assert(
      fc.property(
        carrier,
        fc.nat(),
        anyCase('co-authored-by:'),
        words(3),
        fc.emailAddress(),
        (msg, position, trailer, name, email) => {
          const lines = msg.split('\n');
          const at = position % (lines.length + 1);
          lines.splice(at, 0, `${trailer} ${name} <${email}>`);
          expect(checkCommitMessage(lines.join('\n'))).not.toEqual([]);
        },
      ),
    );
  });

  it('rejects any message containing a Turkish character', () => {
    fc.assert(
      fc.property(carrier, fc.nat(), fc.constantFrom(...'çğıöşüÇĞİÖŞÜ'), (msg, position, ch) => {
        expect(checkCommitMessage(insertAt(msg, position, ch))).not.toEqual([]);
      }),
    );
  });

  it('rejects any message containing an R<digits> plan reference', () => {
    fc.assert(
      fc.property(
        carrier,
        fc.nat(),
        fc.string({ unit: fc.constantFrom(...'0123456789'), minLength: 1, maxLength: 6 }),
        (msg, position, digits) => {
          expect(checkCommitMessage(insertAt(msg, position, ` R${digits} `))).not.toEqual([]);
        },
      ),
    );
  });
});
