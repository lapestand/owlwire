#!/usr/bin/env node
// Every translation catalog must define the same message keys in every locale.
// A catalog is a `messages/` directory under apps/ or packages/ holding one `<locale>.json` per locale (en.json,
// tr.json). Nested objects are flattened to dotted keys (invitation.role.admin). A locale file missing from a
// catalog counts as missing every key.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LOCALES = ['en', 'tr'];
export const CATALOG_DIR = 'messages';

const ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage', 'public']);

/** Dotted paths of the string leaves (and any non-object values) of a parsed catalog, sorted. */
export function flattenKeys(value, prefix = '') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.keys(value)
    .flatMap((k) => flattenKeys(value[k], prefix ? `${prefix}.${k}` : k))
    .sort();
}

/**
 * Keys each locale lacks compared with the union of all locales, as `{ locale: [keys] }`. Locales with nothing
 * missing are left out, so an empty object means the catalogs agree.
 */
export function findMissingKeys(catalogs) {
  const keys = Object.fromEntries(
    Object.entries(catalogs).map(([l, c]) => [l, new Set(flattenKeys(c))]),
  );
  const all = [...new Set(Object.values(keys).flatMap((s) => [...s]))].sort();
  const missing = {};
  for (const [locale, own] of Object.entries(keys)) {
    const lacking = all.filter((k) => !own.has(k));
    if (lacking.length > 0) missing[locale] = lacking;
  }
  return missing;
}

function* catalogDirs(root, dir) {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.name === CATALOG_DIR) yield rel;
    else yield* catalogDirs(root, rel);
  }
}

function readCatalog(root, dir, locale) {
  const file = join(root, dir, `${locale}.json`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${dir}/${locale}.json: ${err.message}`);
  }
}

/** Catalogs whose locales disagree, as `[{ dir, missing: { locale: [keys] } }]` sorted by directory. */
export function checkI18nParity(root) {
  const problems = [];
  for (const top of ROOTS) {
    let dirs;
    try {
      dirs = [...catalogDirs(root, top)];
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const dir of dirs) {
      const catalogs = Object.fromEntries(LOCALES.map((l) => [l, readCatalog(root, dir, l)]));
      const missing = findMissingKeys(catalogs);
      if (Object.keys(missing).length > 0) problems.push({ dir, missing });
    }
  }
  return problems.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Human-readable report lines, one block per catalog and one line per locale. */
export function formatProblems(problems) {
  const lines = ['Translation keys missing (every locale must define the same keys):'];
  for (const p of problems) {
    lines.push(`  ${p.dir}`);
    for (const [locale, keys] of Object.entries(p.missing)) {
      lines.push(`    ${locale}.json is missing: ${keys.join(', ')}`);
    }
  }
  return lines;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const problems = checkI18nParity(fileURLToPath(new URL('..', import.meta.url)));
  if (problems.length > 0) {
    for (const line of formatProblems(problems)) console.error(line);
    process.exit(1);
  }
}
