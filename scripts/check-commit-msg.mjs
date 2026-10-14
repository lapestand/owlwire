#!/usr/bin/env node
// Commit message policy for this repository, used by tools/hooks/commit-msg and by CI.
//   node scripts/check-commit-msg.mjs <file>          check one message (git commit-msg hook)
//   node scripts/check-commit-msg.mjs --range A..B    check every commit in a range (CI)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
];
export const MAX_HEADER = 72;

const HEADER = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9][a-z0-9._/-]*\\))?(!)?: (.+)$`);
// Messages git writes itself.
const GENERATED =
  /^(Merge (branch|pull request|remote-tracking branch|tag) |Revert "|fixup! |squash! |amend! )/;
const NON_ENGLISH = /[çğıöşüÇĞİÖŞÜ]/;
const ATTRIBUTION = [
  /^co-authored-by:/im,
  /generated (with|by)\b/i,
  /\b(claude|anthropic|chatgpt|openai|copilot|gpt-\d)\b/i,
  /\bai[- ](generated|assisted|written)\b/i,
  /\u{1F916}/u,
];
// References to planning documents that are not part of this repository.
const INTERNAL_REFS = [
  /\b(sözleşme|sozlesme|görev|gorev)\b/i,
  /\bR\d{1,3}\b/,
  /\b[pP](0|1[a-z]?|2(\.\d+)?)\b/,
  /\btask \d+\b/i,
  /\b(fix|review) round \d+\b/i,
];

/** Drops the lines git adds for the editor (comments and everything below the scissors line). */
export function cleanMessage(raw) {
  const lines = [];
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    if (/^# -+ >8 -+/.test(line)) break;
    if (line.startsWith('#')) continue;
    lines.push(line);
  }
  return lines.join('\n').trim();
}

/** Returns the list of policy violations in a commit message; an empty list means it is acceptable. */
export function checkCommitMessage(raw) {
  const msg = cleanMessage(raw);
  if (msg === '') return ['the message is empty'];
  const header = msg.split('\n')[0];
  const problems = [];
  // A header git writes itself (merge, revert, fixup) is exempt from the shape rules only; the content rules below
  // still apply to the whole message, so such a header cannot carry attribution, Turkish text or plan references.
  if (!GENERATED.test(header)) problems.push(...headerShapeProblems(msg, header));
  if (NON_ENGLISH.test(msg)) problems.push('write the message in English');
  if (ATTRIBUTION.some((re) => re.test(msg)))
    problems.push('remove tool or co-author attribution lines');
  if (INTERNAL_REFS.some((re) => re.test(msg))) {
    problems.push('remove references to internal plans or tasks (for example R12, P1a, task 3)');
  }
  return problems;
}

/** Layout rules for a hand-written message: conventional header, header length and the blank line after it. */
function headerShapeProblems(msg, header) {
  const problems = [];
  const m = HEADER.exec(header);
  if (!m) {
    problems.push(
      `the header must look like "<type>(<optional scope>): <description>", type one of: ${TYPES.join(', ')}`,
    );
  } else {
    const description = m[4];
    if (/^[A-Z]/.test(description))
      problems.push('the description must start with a lowercase letter');
    if (/[.!?]$/.test(description)) problems.push('the description must not end with punctuation');
  }
  if (header.length > MAX_HEADER)
    problems.push(`the header is longer than ${MAX_HEADER} characters`);
  const lines = msg.split('\n');
  if (lines.length > 1 && lines[1].trim() !== '')
    problems.push('leave a blank line between the header and the body');
  return problems;
}

function report(label, problems) {
  console.error(`${label}:`);
  for (const p of problems) console.error(`  - ${p}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const args = process.argv.slice(2);
  let failed = false;
  if (args[0] === '--range' && args[1]) {
    const shas = execFileSync('git', ['rev-list', '--no-merges', args[1]], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
    for (const sha of shas) {
      const body = execFileSync('git', ['log', '-1', '--format=%B', sha], { encoding: 'utf8' });
      const problems = checkCommitMessage(body);
      if (problems.length > 0) {
        failed = true;
        report(`commit ${sha.slice(0, 7)} "${body.split('\n')[0]}"`, problems);
      }
    }
  } else if (args[0]) {
    const problems = checkCommitMessage(readFileSync(args[0], 'utf8'));
    if (problems.length > 0) {
      failed = true;
      report('commit message rejected', problems);
    }
  } else {
    console.error('usage: check-commit-msg.mjs <message-file> | --range <rev-range>');
    process.exit(2);
  }
  process.exit(failed ? 1 : 0);
}
