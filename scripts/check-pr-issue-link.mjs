#!/usr/bin/env node
// Pull request description policy: every PR links the issue it works on, so the roadmap board stays accurate.
//   node scripts/check-pr-issue-link.mjs <body-file> [author]    (CI: PR description job)
// Accepted, case-insensitive:
//   - a closing keyword with an issue: Fixes #12, Closes #12, Resolves #12 (also fix/fixed, close/closed,
//     resolve/resolved, as GitHub accepts them), or owner/repo#12
//   - a reference: Refs #12
//   - for trivial changes, a line `No issue: <reason>` with a non-empty reason
// Dependabot pull requests are exempt. HTML comments (the template's hints) are ignored.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXEMPT_AUTHORS = ['dependabot[bot]'];

const ISSUE = String.raw`(?:[\w.-]+\/[\w.-]+)?#\d+`;
const LINK = new RegExp(
  String.raw`(?<![\w-])(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs)\s*:?\s+${ISSUE}\b`,
  'i',
);
// The reason must be real text, not the `<reason>` placeholder from the docs.
const NO_ISSUE = /^[ \t]*no issue:[ \t]*(?!<reason>[ \t]*$)\S/im;

/** Drops HTML comments, so the hints in the pull request template never count as a link. */
const stripComments = (body) => body.replace(/<!--[\s\S]*?(?:-->|$)/g, '');

/**
 * @param {string | null | undefined} body
 * @param {string} [author]
 * @returns {{ ok: boolean, reason: string }}
 */
export function checkPrIssueLink(body, author = '') {
  if (EXEMPT_AUTHORS.includes(author)) return { ok: true, reason: `${author} is exempt` };
  const text = stripComments(String(body ?? '').replace(/\r\n/g, '\n'));
  if (LINK.test(text)) return { ok: true, reason: 'links an issue' };
  if (NO_ISSUE.test(text)) return { ok: true, reason: 'has a "No issue:" line with a reason' };
  return {
    ok: false,
    reason:
      'the description links no issue. Add "Fixes #<n>" (or Closes/Resolves) to close an issue, "Refs #<n>" to ' +
      'reference one, or, for a trivial change, a line "No issue: <reason>".',
  };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const [file, author = ''] = process.argv.slice(2);
  if (!file) {
    console.error('usage: check-pr-issue-link.mjs <body-file> [author]');
    process.exit(2);
  }
  const { ok, reason } = checkPrIssueLink(readFileSync(file, 'utf8'), author);
  if (ok) {
    console.log(`ok: ${reason}`);
  } else {
    console.log(`::error title=Pull request description::${reason}`);
    process.exit(1);
  }
}
