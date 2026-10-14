import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkPrIssueLink } from './check-pr-issue-link.mjs';

const keyword = fc.constantFrom(
  'Fixes',
  'fixes',
  'FIX',
  'Fixed',
  'Closes',
  'close',
  'Closed',
  'Resolves',
  'resolve',
  'RESOLVED',
  'Refs',
  'refs',
);
const issueNumber = fc.integer({ min: 1, max: 1_000_000 });
// Free text without '#', '<' or a line starting with "no issue", so it can neither link nor hide a link.
const filler = fc
  .string({ unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz .,:;()\n') })
  .filter((t) => !/^\s*no issue/im.test(t));

describe('checkPrIssueLink properties', () => {
  it('accepts any body that contains a keyword with an issue number', () => {
    fc.assert(
      fc.property(filler, keyword, issueNumber, filler, (before, kw, n, after) => {
        expect(checkPrIssueLink(`${before}\n${kw} #${n}\n${after}`).ok).toBe(true);
      }),
    );
  });

  it('rejects any body without an issue number or a "No issue:" line', () => {
    fc.assert(
      fc.property(filler, (body) => {
        expect(checkPrIssueLink(body).ok).toBe(false);
      }),
    );
  });

  it('never counts a link that only appears inside an HTML comment', () => {
    fc.assert(
      fc.property(filler, keyword, issueNumber, (body, kw, n) => {
        expect(checkPrIssueLink(`${body}<!-- ${kw} #${n} -->`).ok).toBe(false);
      }),
    );
  });
});
