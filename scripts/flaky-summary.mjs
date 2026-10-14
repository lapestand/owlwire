#!/usr/bin/env node
// Turns a vitest JSON report from one shuffled integration run into a Markdown job summary: the seed, how to
// replay the same order, and every failed test (or test file that failed to load) with its first error line.
//   node scripts/flaky-summary.mjs <report.json> <seed> [run label] >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const firstLine = (text) =>
  String(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '') ?? '';

/** Table cells cannot hold pipes or newlines. */
const cell = (text) => text.replace(/\|/g, '\\|').slice(0, 300);

/**
 * @param {{ success?: boolean, numTotalTests?: number, numFailedTests?: number, testResults?: Array<{
 *   name: string, status: string, message?: string,
 *   assertionResults?: Array<{ fullName: string, status: string, failureMessages?: string[] }> }> }} report
 * @param {{ seed: string, label?: string, root?: string }} opts
 * @returns {{ markdown: string, failures: Array<{ file: string, test: string, error: string }> }}
 */
export function renderFlakyMarkdown(
  report,
  { seed, label = 'Shuffled run', root = process.cwd() },
) {
  const failures = [];
  for (const file of report.testResults ?? []) {
    const path = relative(root, file.name);
    const failed = (file.assertionResults ?? []).filter((t) => t.status === 'failed');
    for (const t of failed) {
      failures.push({ file: path, test: t.fullName, error: firstLine(t.failureMessages?.[0]) });
    }
    // A file can fail without a failing test: an import error or a failing beforeAll/afterAll hook.
    if (failed.length === 0 && file.status === 'failed') {
      failures.push({ file: path, test: '(file or hook)', error: firstLine(file.message) });
    }
  }

  const ok = failures.length === 0 && report.success !== false;
  const out = [`## ${label}: ${ok ? 'passed' : 'failed'}`, ''];
  out.push(`- Seed: \`${seed}\``);
  out.push(`- Tests: ${report.numTotalTests ?? 0} total, ${report.numFailedTests ?? 0} failed`);
  out.push(`- Replay: \`./dev pnpm test:int --sequence.shuffle --sequence.seed=${seed}\``, '');
  if (failures.length > 0) {
    out.push('| File | Test | Error |', '| --- | --- | --- |');
    for (const f of failures) {
      out.push(`| \`${cell(f.file)}\` | ${cell(f.test)} | ${cell(f.error)} |`);
    }
    out.push('');
  } else if (!ok) {
    out.push('The run failed without a failing test in the report; see the job log.', '');
  }
  return { markdown: `${out.join('\n')}\n`, failures };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const [file, seed, label] = process.argv.slice(2);
  if (!file || !seed) {
    console.error('usage: flaky-summary.mjs <report.json> <seed> [run label]');
    process.exit(2);
  }
  const root = fileURLToPath(new URL('..', import.meta.url));
  const report = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const { markdown, failures } = renderFlakyMarkdown(report, { seed, label, root });
  process.stdout.write(markdown);
  // Annotations put the seed next to each failing test on the run page.
  for (const f of failures) {
    console.error(`::error file=${f.file},title=Failed with seed ${seed}::${f.test}: ${f.error}`);
  }
}
