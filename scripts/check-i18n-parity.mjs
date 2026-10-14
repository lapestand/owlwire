#!/usr/bin/env node
// Translation catalogs must agree across locales.
//
// A catalog is any directory inside a `messages/` tree under apps/ or packages/ (the `messages/` directory itself or
// a namespace below it, such as messages/auth/) that holds files. Every file there must be `<locale>.json`
// (en.json, tr.json, en-US.json); anything else is reported. Each of REQUIRED_LOCALES must exist, and every locale
// file found is compared, so a new locale is checked without editing this script.
//
// Within a catalog, every locale must define the same keys (nested objects flatten to dotted paths such as
// invitation.role.admin), every value must be a non-empty string, a key must not contain a dot (it would collide
// with a nested path) and each key must use the same set of {placeholder} names in every locale.
//
// Usage: node scripts/check-i18n-parity.mjs [root]   (root defaults to the repository)
import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_LOCALES = ['en', 'tr'];
export const CATALOG_DIR = 'messages';

const ROOTS = ['apps', 'packages'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.turbo', 'coverage']);
// Build output that holds copies of source files (gitignored); the sources are checked instead.
const SKIP_PATHS = new Set(['apps/server/public']);
const LOCALE_FILE = /^([a-z]{2,3}(?:-[A-Z]{2})?)\.json$/;
const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Leaves of a parsed catalog as `{ entries: Map<dottedKey, value>, invalid: [{ key, reason }] }`. Objects are
 * walked; anything else is a leaf. Leaves that are not non-empty strings and keys with dots are reported.
 */
export function flattenCatalog(value) {
  const entries = new Map();
  const invalid = [];
  const walk = (node, prefix) => {
    for (const [k, v] of Object.entries(node)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (k === '' || k.includes('.'))
        invalid.push({ key, reason: 'key is empty or contains a dot' });
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, key);
      } else if (typeof v !== 'string') {
        invalid.push({ key, reason: 'value is not a string' });
      } else if (v.trim() === '') {
        invalid.push({ key, reason: 'value is empty' });
      } else if (entries.has(key)) {
        invalid.push({ key, reason: 'key is defined twice' });
      } else {
        entries.set(key, v);
      }
    }
  };
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid.push({ key: '(root)', reason: 'catalog must be a JSON object' });
  } else {
    walk(value, '');
  }
  return { entries, invalid };
}

/** Dotted keys of a catalog's string leaves, sorted. */
export function flattenKeys(value) {
  return [...flattenCatalog(value).entries.keys()].sort();
}

function placeholders(text) {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]))].sort();
}

/**
 * Compares parsed catalogs `{ locale: object }`. Returns
 * `{ missing: { locale: [keys] }, placeholders: [{ key, byLocale: { locale: [names] } }], invalid: { locale: [...] } }`
 * where only locales and keys with a problem appear.
 */
export function compareCatalogs(catalogs) {
  const flat = Object.fromEntries(Object.entries(catalogs).map(([l, c]) => [l, flattenCatalog(c)]));
  const all = [...new Set(Object.values(flat).flatMap((f) => [...f.entries.keys()]))].sort();
  const missing = {};
  const invalid = {};
  for (const [locale, f] of Object.entries(flat)) {
    const lacking = all.filter((k) => !f.entries.has(k));
    if (lacking.length > 0) missing[locale] = lacking;
    if (f.invalid.length > 0) invalid[locale] = f.invalid;
  }
  const placeholderProblems = [];
  for (const key of all) {
    const byLocale = {};
    for (const [locale, f] of Object.entries(flat)) {
      const text = f.entries.get(key);
      if (text !== undefined) byLocale[locale] = placeholders(text);
    }
    const shapes = new Set(Object.values(byLocale).map((names) => names.join(',')));
    if (shapes.size > 1) placeholderProblems.push({ key, byLocale });
  }
  return { missing, placeholders: placeholderProblems, invalid };
}

/** Keys each locale lacks compared with the union of all locales; locales with nothing missing are left out. */
export function findMissingKeys(catalogs) {
  return compareCatalogs(catalogs).missing;
}

/** Directories inside a `messages/` tree that hold at least one file, relative to root. */
function* catalogDirs(root, dir, inside) {
  const entries = readdirSync(join(root, dir), { withFileTypes: true });
  if (inside && entries.some((e) => !e.isDirectory())) yield dir;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (SKIP_PATHS.has(rel)) continue;
    yield* catalogDirs(root, rel, inside || entry.name === CATALOG_DIR);
  }
}

function checkCatalogDir(root, dir) {
  const files = readdirSync(join(root, dir), { withFileTypes: true }).filter(
    (e) => !e.isDirectory(),
  );
  const unexpectedFiles = [];
  const catalogs = {};
  for (const file of files.map((f) => f.name).sort()) {
    const m = LOCALE_FILE.exec(file);
    if (!m) {
      unexpectedFiles.push(file);
      continue;
    }
    const text = readFileSync(join(root, dir, file), 'utf8');
    try {
      catalogs[m[1]] = JSON.parse(text);
    } catch (err) {
      throw new Error(`${dir}/${file}: ${err.message}`);
    }
  }
  // A required locale without a file counts as missing every key.
  for (const locale of REQUIRED_LOCALES) catalogs[locale] ??= {};
  return { unexpectedFiles, ...compareCatalogs(catalogs) };
}

function hasProblems(r) {
  return (
    r.unexpectedFiles.length > 0 ||
    Object.keys(r.missing).length > 0 ||
    r.placeholders.length > 0 ||
    Object.keys(r.invalid).length > 0
  );
}

/**
 * Catalogs with problems, sorted by directory:
 * `[{ dir, unexpectedFiles, missing, placeholders, invalid }]`. Empty when every catalog agrees.
 */
export function checkI18nParity(root) {
  const problems = [];
  for (const top of ROOTS) {
    let dirs;
    try {
      dirs = [...catalogDirs(root, top, false)];
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for (const dir of dirs) {
      const result = checkCatalogDir(root, dir);
      if (hasProblems(result)) problems.push({ dir, ...result });
    }
  }
  return problems.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Human-readable report lines: one block per catalog, one line per locale or key. */
export function formatProblems(problems) {
  const lines = ['Translation catalogs disagree (every locale must define the same keys):'];
  for (const p of problems) {
    lines.push(`  ${p.dir}`);
    for (const file of p.unexpectedFiles ?? []) {
      lines.push(
        `    unexpected file ${file}: only <locale>.json files belong in a messages directory`,
      );
    }
    for (const [locale, keys] of Object.entries(p.missing ?? {})) {
      lines.push(`    ${locale}.json is missing: ${keys.join(', ')}`);
    }
    for (const { key, byLocale } of p.placeholders ?? []) {
      const sets = Object.entries(byLocale).map(([l, names]) => `${l} {${names.join(', ')}}`);
      lines.push(`    placeholders differ for ${key}: ${sets.join(', ')}`);
    }
    for (const [locale, items] of Object.entries(p.invalid ?? {})) {
      for (const { key, reason } of items) lines.push(`    ${locale}.json ${key}: ${reason}`);
    }
  }
  return lines;
}

/** Runs the check and prints the report; returns the process exit code. */
export function main(root, log = console.error) {
  const problems = checkI18nParity(root);
  if (problems.length === 0) return 0;
  for (const line of formatProblems(problems)) log(line);
  return 1;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const root = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL('..', import.meta.url));
  process.exitCode = main(root);
}
