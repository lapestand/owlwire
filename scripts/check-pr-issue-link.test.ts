import { describe, expect, it } from 'vitest';
import { checkPrIssueLink } from './check-pr-issue-link.mjs';

const ok = (body: string, author?: string) => checkPrIssueLink(body, author).ok;

describe('checkPrIssueLink', () => {
  it.each([
    'Fixes #12',
    'fixes #12',
    'FIXED #3',
    'Fix #3',
    'Closes #7',
    'closed #7',
    'Resolves #345',
    'resolve #345',
    'Refs #9',
    'refs: #9',
    'Fixes lapestand/owlwire#12',
    '## What\n\nAdds a thing.\n\nFixes #12\n',
    'Adds a thing (Refs #4).',
  ])('accepts %j', (body) => {
    expect(ok(body)).toBe(true);
  });

  it.each([
    '',
    'Adds a thing.',
    'Fixes #',
    'Fixes #abc',
    'Fixes 12',
    '#12',
    'See issue 12',
    'prefixes #12',
    'Prefix-refs #12',
    '<!-- Fixes #12 -->',
    'Body\n<!-- unterminated comment Fixes #12',
  ])('rejects %j', (body) => {
    expect(ok(body)).toBe(false);
  });

  it('accepts a "No issue:" line with a reason, case-insensitively', () => {
    expect(ok('Bumps a comment.\n\nNo issue: typo fix')).toBe(true);
    expect(ok('no issue: formatting only')).toBe(true);
    expect(ok('  NO ISSUE:   docs wording')).toBe(true);
  });

  it('rejects a "No issue:" line without a real reason', () => {
    expect(ok('No issue:')).toBe(false);
    expect(ok('No issue:   \nmore text')).toBe(false);
    expect(ok('No issue: <reason>')).toBe(false);
    expect(ok('Mentions No issue: inline, not as a line')).toBe(false);
    expect(ok('<!-- No issue: hidden -->')).toBe(false);
  });

  it('ignores the template hints but accepts a link filled in below them', () => {
    const template =
      '## What and why\n\n<!-- What does this change? Fixes #1 -->\n\nFixes #\n\n## How it was tested\n';
    expect(ok(template)).toBe(false);
    expect(ok(template.replace('Fixes #\n', 'Fixes #355\n'))).toBe(true);
  });

  it('handles CRLF line endings', () => {
    expect(ok('Text\r\nNo issue: tidy up\r\n')).toBe(true);
  });

  it('exempts Dependabot and only Dependabot', () => {
    expect(checkPrIssueLink('Bumps pg from 8.1 to 8.2.', 'dependabot[bot]')).toEqual({
      ok: true,
      reason: 'dependabot[bot] is exempt',
    });
    expect(ok('Bumps pg from 8.1 to 8.2.', 'dependabot')).toBe(false);
    expect(ok('Bumps pg from 8.1 to 8.2.', 'renovate[bot]')).toBe(false);
  });

  it('explains how to fix a failing description', () => {
    const { reason } = checkPrIssueLink('nothing here');
    expect(reason).toContain('Fixes #<n>');
    expect(reason).toContain('Refs #<n>');
    expect(reason).toContain('No issue: <reason>');
  });

  it('treats a missing body as empty', () => {
    expect(checkPrIssueLink(undefined).ok).toBe(false);
    expect(checkPrIssueLink(null).ok).toBe(false);
  });
});
