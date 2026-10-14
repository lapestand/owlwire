#!/usr/bin/env node
// Keeps deploy/compose/.env.example in sync with the OWLWIRE_* variables the code reads.
//   - Every variable in the config loader's schema (apps/server/src/config/load.ts) and every other
//     process.env.OWLWIRE_* read must be listed in .env.example, or be set by the compose file itself.
//   - Every variable listed in .env.example must be read by the code, or be interpolated by the compose file.
// Variables that are neither, on purpose, go in ALLOWLIST with the reason.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOADER = 'apps/server/src/config/load.ts';
// Further files that parse the environment with their own zod object, and the const that holds it.
export const EXTRA_SCHEMAS = [['apps/server/src/config/auth-env.ts', 'authEnvSchema']];
export const ENV_EXAMPLE = 'deploy/compose/.env.example';
export const COMPOSE = 'deploy/compose/docker-compose.yml';

const ROOTS = ['apps', 'packages', 'scripts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'public']);
const SCANNED = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
// Test files set variables for the code under test; what they read themselves is test-only.
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;

/** Variables that may appear on one side only. Each entry needs the reason. */
export const ALLOWLIST = new Map([
  // Test-only: overrides the Postgres image that Testcontainers starts for the integration tests.
  ['OWLWIRE_TEST_PG_IMAGE', 'test-only Postgres image override'],
]);

const NAME = 'OWLWIRE_[A-Z0-9_]*[A-Z0-9]';

/** Keys of the zod object the config loader parses the environment with. */
export function schemaKeys(text, constName = 'envSchema') {
  const start = text.search(new RegExp(`\\bconst ${constName}\\s*=\\s*z\\.object\\(\\{`));
  if (start === -1) throw new Error(`${constName} = z.object({ ... }) not found`);
  const body = text.slice(start, text.indexOf('\n});', start));
  return [...body.matchAll(new RegExp(`^\\s*['"]?(${NAME})['"]?\\s*:`, 'gm'))].map((m) => m[1]);
}

/** OWLWIRE_* names read from process.env: member access, bracket access and destructuring. */
export function processEnvReads(text) {
  const names = new Set();
  const access = new RegExp(`process\\.env(?:\\?\\.|\\.)(${NAME})\\b`, 'g');
  const bracket = new RegExp(`process\\.env(?:\\?\\.)?\\[\\s*['"\`](${NAME})['"\`]\\s*\\]`, 'g');
  for (const re of [access, bracket]) for (const m of text.matchAll(re)) names.add(m[1]);
  for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g)) {
    for (const n of m[1].matchAll(new RegExp(`\\b(${NAME})\\b`, 'g'))) names.add(n[1]);
  }
  return [...names];
}

/** Names assigned in a dotenv file (KEY=value lines; comments and blank lines ignored). */
export function envFileKeys(text) {
  return [...text.matchAll(new RegExp(`^\\s*(?:export\\s+)?(${NAME})\\s*=`, 'gm'))].map(
    (m) => m[1],
  );
}

/** OWLWIRE_* names a compose file sets in `environment:` and names it interpolates (${VAR}). */
export function composeVariables(text) {
  const provided = new Set();
  for (const m of text.matchAll(new RegExp(`^\\s+(?:-\\s*)?(${NAME})\\s*[:=]`, 'gm'))) {
    provided.add(m[1]);
  }
  const interpolated = new Set();
  for (const m of text.matchAll(new RegExp(`\\$\\{?(${NAME})`, 'g'))) interpolated.add(m[1]);
  return { provided: [...provided], interpolated: [...interpolated] };
}

function* walk(root, dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* walk(root, rel);
    } else if (SCANNED.test(entry.name) && !TEST_FILE.test(entry.name)) {
      yield rel;
    }
  }
}

function addSource(map, name, file) {
  if (!map.has(name)) map.set(name, new Set());
  map.get(name).add(file);
}

/** Variables the code reads, each with the files that read it. */
export function codeReads(root) {
  const reads = new Map();
  for (const name of schemaKeys(readFileSync(join(root, LOADER), 'utf8'))) {
    addSource(reads, name, LOADER);
  }
  for (const [file, constName] of EXTRA_SCHEMAS) {
    for (const name of schemaKeys(readFileSync(join(root, file), 'utf8'), constName)) {
      addSource(reads, name, file);
    }
  }
  for (const top of ROOTS) {
    let files;
    try {
      files = [...walk(root, top)];
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const file of files) {
      for (const name of processEnvReads(readFileSync(join(root, file), 'utf8'))) {
        addSource(reads, name, file);
      }
    }
  }
  return reads;
}

/**
 * Compares the code with .env.example. `missing`: read by the code but absent from .env.example and the
 * compose environment. `unused`: listed in .env.example but neither read by the code nor used by compose.
 */
export function checkEnv(root, allowlist = ALLOWLIST) {
  const reads = codeReads(root);
  const example = new Set(envFileKeys(readFileSync(join(root, ENV_EXAMPLE), 'utf8')));
  const compose = composeVariables(readFileSync(join(root, COMPOSE), 'utf8'));
  const provided = new Set(compose.provided);
  const interpolated = new Set(compose.interpolated);

  const missing = [...reads.keys()]
    .filter((n) => !example.has(n) && !provided.has(n) && !allowlist.has(n))
    .sort()
    .map((name) => ({ name, files: [...reads.get(name)].sort() }));
  const unused = [...example]
    .filter((n) => !reads.has(n) && !interpolated.has(n) && !allowlist.has(n))
    .sort();
  return { missing, unused };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const { missing, unused } = checkEnv(fileURLToPath(new URL('..', import.meta.url)));
  for (const m of missing) {
    console.error(`${m.name} is read by ${m.files.join(', ')} but missing from ${ENV_EXAMPLE}`);
  }
  for (const name of unused) {
    console.error(`${name} is listed in ${ENV_EXAMPLE} but nothing reads it`);
  }
  if (missing.length > 0 || unused.length > 0) {
    console.error(
      `Update ${ENV_EXAMPLE}, or add a test-only or dev-only variable to ALLOWLIST in scripts/check-env.mjs.`,
    );
    process.exit(1);
  }
}
