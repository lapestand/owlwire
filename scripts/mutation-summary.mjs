#!/usr/bin/env node
// Turns Stryker's JSON report (mutation-testing-report-schema) into a Markdown job summary: the mutation score
// per mutated file and overall, and the mutants no test noticed. Informational: never fails on a low score.
//   node scripts/mutation-summary.mjs [reports/mutation/mutation.json] >> "$GITHUB_STEP_SUMMARY"
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DETECTED = new Set(['Killed', 'Timeout']);
const UNDETECTED = new Set(['Survived', 'NoCoverage']);

const score = (detected, undetected) =>
  detected + undetected === 0
    ? 'n/a'
    : `${((detected / (detected + undetected)) * 100).toFixed(2)}%`;

/** Table cells cannot hold raw pipes or newlines; backslashes are escaped first. */
const cell = (text) =>
  String(text)
    .replace(/\s+/g, ' ')
    .slice(0, 120)
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/`/g, "'");

/**
 * Mutation score as Stryker defines it: detected / (detected + undetected). Compile and runtime errors and
 * ignored mutants count for neither side.
 * @param {{ files: Record<string, { mutants: Array<{ mutatorName: string, replacement?: string, status: string,
 *   location: { start: { line: number } } }> }> }} report
 * @param {{ limit?: number }} [opts]
 */
export function renderMutationMarkdown(report, { limit = 50 } = {}) {
  const rows = [];
  const survivors = [];
  let totalDetected = 0;
  let totalUndetected = 0;
  for (const [file, { mutants }] of Object.entries(report.files ?? {}).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const count = (set) => mutants.filter((m) => set.has(m.status)).length;
    const detected = count(DETECTED);
    const undetected = count(UNDETECTED);
    const survived = mutants.filter((m) => m.status === 'Survived').length;
    const noCoverage = undetected - survived;
    totalDetected += detected;
    totalUndetected += undetected;
    rows.push(
      `| \`${file}\` | ${score(detected, undetected)} | ${detected} | ${survived} | ${noCoverage} | ${mutants.length} |`,
    );
    for (const m of mutants) {
      if (UNDETECTED.has(m.status)) survivors.push({ file, ...m });
    }
  }

  const out = ['## Mutation testing', ''];
  out.push(
    `Overall mutation score: **${score(totalDetected, totalUndetected)}** (${totalDetected} detected, ${totalUndetected} undetected)`,
    '',
  );
  out.push(
    '| File | Score | Detected | Survived | No coverage | Mutants |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
  );
  out.push(...rows, '');
  if (survivors.length > 0) {
    survivors.sort(
      (a, b) => a.file.localeCompare(b.file) || a.location.start.line - b.location.start.line,
    );
    out.push(
      `### Undetected mutants (${Math.min(limit, survivors.length)} of ${survivors.length})`,
      '',
    );
    out.push('| Location | Status | Mutator | Replacement |', '| --- | --- | --- | --- |');
    for (const m of survivors.slice(0, limit)) {
      out.push(
        `| \`${m.file}:${m.location.start.line}\` | ${m.status} | ${cell(m.mutatorName)} | \`${cell(m.replacement ?? '')}\` |`,
      );
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const file = resolve(process.argv[2] ?? resolve(root, 'reports/mutation/mutation.json'));
  process.stdout.write(renderMutationMarkdown(JSON.parse(readFileSync(file, 'utf8'))));
}
