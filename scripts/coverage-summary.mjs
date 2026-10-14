#!/usr/bin/env node
// Turns coverage/coverage-summary.json (vitest json-summary reporter) into a Markdown report:
// total percentages and the least-covered files. Informational only: never fails on low numbers.
//   node scripts/coverage-summary.mjs [coverage/coverage-summary.json] >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const METRICS = ['lines', 'branches', 'functions', 'statements'];

const pct = (m) => (m.total === 0 ? '100.00' : Number(m.pct).toFixed(2));

/**
 * @param {Record<string, Record<string, {total: number, covered: number, pct: number}>>} summary
 * @param {{ root?: string, limit?: number }} [opts]
 */
export function renderCoverageMarkdown(summary, { root = process.cwd(), limit = 10 } = {}) {
  const { total, ...files } = summary;
  if (!total) throw new Error('coverage summary has no "total" entry');
  const out = ['## Test coverage (unit + integration)', ''];
  out.push('| Lines | Branches | Functions | Statements |', '| ---: | ---: | ---: | ---: |');
  out.push(`| ${METRICS.map((k) => `${pct(total[k])}%`).join(' | ')} |`, '');

  const ranked = Object.entries(files)
    .map(([path, m]) => ({
      file: relative(root, path),
      m,
      uncovered: m.lines.total - m.lines.covered,
    }))
    .filter((f) => f.m.lines.total > 0)
    .sort(
      (a, b) =>
        a.m.lines.pct - b.m.lines.pct || b.uncovered - a.uncovered || a.file.localeCompare(b.file),
    )
    .slice(0, limit);
  out.push(`### ${limit} least-covered files`, '');
  out.push(
    '| File | Lines | Branches | Functions | Uncovered lines |',
    '| --- | ---: | ---: | ---: | ---: |',
  );
  for (const { file, m, uncovered } of ranked) {
    out.push(
      `| \`${file}\` | ${pct(m.lines)}% | ${pct(m.branches)}% | ${pct(m.functions)}% | ${uncovered} |`,
    );
  }
  return `${out.join('\n')}\n`;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const file = resolve(process.argv[2] ?? resolve(root, 'coverage/coverage-summary.json'));
  const summary = JSON.parse(readFileSync(file, 'utf8'));
  process.stdout.write(renderCoverageMarkdown(summary, { root }));
}
