#!/usr/bin/env node
// R123: the owlwire.system GUC is turned on only by withSystem (packages/db/src/scope.ts).
// Reads (current_setting) and the clearing form (set_config('owlwire.system', '', ...)) are allowed
// everywhere; any other write is an offence outside scope.ts and packages/db integration tests.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// deploy/ and docker/ hold init scripts, compose files and the image recipe (init SQL, PGOPTIONS, ALTER ROLE).
const ROOTS = ['apps', 'packages', 'deploy', 'docker'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'public']);
// Build copy of packages/db/drizzle (gitignored); the source folder is scanned.
const SKIP_PATHS = new Set(['apps/server/drizzle']);
const SCANNED = /(\.(ts|tsx|js|mjs|cjs|sql|sh|ya?ml)|^Dockerfile.*|\.env.*)$/;
const ALLOWED = [/^packages\/db\/src\/scope\.ts$/, /^packages\/db\/src\/.*\.int\.test\.ts$/];

// A quote as it appears in SQL text, possibly escaped inside a JS string literal.
const Q = String.raw`\\?'`;
const ENABLING = [
  // set_config('owlwire.system', <anything but ''>, ...)
  new RegExp(String.raw`set_config\(\s*${Q}owlwire\.system${Q}\s*,\s*(?!${Q}${Q}\s*[,)])`, 'gi'),
  // SET [LOCAL|SESSION] owlwire.system ... (also ALTER ROLE/DATABASE ... SET owlwire.system)
  /\bset\s+(?:local\s+|session\s+)?owlwire\.system\b/gi,
  // libpq/server options: PGOPTIONS='-c owlwire.system=on', postgres -c owlwire.system=on
  /-c\s*owlwire\.system\s*=/gi,
];

function* walk(root, dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !SKIP_PATHS.has(rel)) yield* walk(root, rel);
    } else if (SCANNED.test(entry.name)) {
      yield rel;
    }
  }
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** Writes that enable system mode outside the allowed files, sorted by path. */
export function findSystemGucWrites(root) {
  const offenders = [];
  for (const top of ROOTS) {
    let files;
    try {
      files = [...walk(root, top)];
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const file of files.sort()) {
      if (ALLOWED.some((re) => re.test(file))) continue;
      const text = readFileSync(join(root, file), 'utf8');
      const hits = ENABLING.flatMap((re) => [...text.matchAll(re)].map((m) => m.index));
      if (hits.length > 0) offenders.push({ file, line: lineOf(text, Math.min(...hits)) });
    }
  }
  return offenders.sort((a, b) => a.file.localeCompare(b.file));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const offenders = findSystemGucWrites(fileURLToPath(new URL('..', import.meta.url)));
  if (offenders.length > 0) {
    console.error(
      'owlwire.system may only be turned on inside withSystem (packages/db/src/scope.ts), R123:',
    );
    for (const o of offenders) console.error(`  ${o.file}:${o.line}`);
    process.exit(1);
  }
}
