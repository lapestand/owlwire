import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkI18nParity,
  compareCatalogs,
  findMissingKeys,
  flattenCatalog,
  flattenKeys,
  formatProblems,
  main,
} from './check-i18n-parity.mjs';

const SCRIPT = fileURLToPath(new URL('./check-i18n-parity.mjs', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function repoWith(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'i18n-parity-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const empty = { unexpectedFiles: [], missing: {}, placeholders: [], invalid: {} };

describe('flattenKeys', () => {
  it('flattens nested objects to sorted dotted keys', () => {
    expect(flattenKeys({ b: 'x', a: { d: 'y', c: { e: 'z' } } })).toEqual(['a.c.e', 'a.d', 'b']);
  });
});

describe('flattenCatalog', () => {
  it('reports values that are not non-empty strings', () => {
    const { entries, invalid } = flattenCatalog({
      ok: 'x',
      list: ['a'],
      n: 1,
      nil: null,
      blank: '  ',
      e: '',
    });
    expect([...entries.keys()]).toEqual(['ok']);
    expect(invalid).toEqual([
      { key: 'list', reason: 'value is not a string' },
      { key: 'n', reason: 'value is not a string' },
      { key: 'nil', reason: 'value is not a string' },
      { key: 'blank', reason: 'value is empty' },
      { key: 'e', reason: 'value is empty' },
    ]);
  });

  it('reports dotted keys and the collision they cause', () => {
    const { invalid } = flattenCatalog({ 'a.b': 'x', a: { b: 'y' } });
    expect(invalid).toEqual([
      { key: 'a.b', reason: 'key is empty or contains a dot' },
      { key: 'a.b', reason: 'key is defined twice' },
    ]);
  });

  it('reports a catalog that is not an object', () => {
    expect(flattenCatalog(['a']).invalid).toEqual([
      { key: '(root)', reason: 'catalog must be a JSON object' },
    ]);
  });
});

describe('compareCatalogs', () => {
  it('returns nothing when the locales define the same keys and placeholders', () => {
    expect(
      compareCatalogs({ en: { a: { b: 'Hi {name}' } }, tr: { a: { b: 'Merhaba {name}' } } }),
    ).toEqual({ missing: {}, placeholders: [], invalid: {} });
  });

  it('reports the keys each locale lacks', () => {
    const en = { greet: 'Hi', role: { admin: 'an admin', member: 'a member' } };
    const tr = { greet: 'Merhaba', role: { admin: 'yönetici' }, extra: 'yalnız' };
    expect(findMissingKeys({ en, tr })).toEqual({ en: ['extra'], tr: ['role.member'] });
  });

  it('reports a key that is a string in one locale and an object in the other on both sides', () => {
    expect(findMissingKeys({ en: { a: 'x' }, tr: { a: { b: 'y' } } })).toEqual({
      en: ['a.b'],
      tr: ['a'],
    });
  });

  it('reports placeholder sets that differ per key', () => {
    const en = { a: 'Hi {name}, {name}', b: '{x} and {y}', c: 'same {v}' };
    const tr = { a: 'Merhaba', b: '{y} ve {x} {z}', c: 'aynı {v}' };
    expect(compareCatalogs({ en, tr }).placeholders).toEqual([
      { key: 'a', byLocale: { en: ['name'], tr: [] } },
      { key: 'b', byLocale: { en: ['x', 'y'], tr: ['x', 'y', 'z'] } },
    ]);
  });

  it('compares every locale given, not only the required ones', () => {
    expect(findMissingKeys({ en: { a: 'x' }, tr: { a: 'y' }, de: {} })).toEqual({ de: ['a'] });
  });
});

describe('checkI18nParity', () => {
  it('passes catalogs that agree', () => {
    const root = repoWith({
      'apps/server/src/mail/messages/en.json': { a: 'x' },
      'apps/server/src/mail/messages/tr.json': { a: 'y' },
    });
    expect(checkI18nParity(root)).toEqual([]);
  });

  it('reports missing keys per catalog and per locale, sorted by directory', () => {
    const root = repoWith({
      'packages/core/src/messages/en.json': { a: 'x', b: 'x' },
      'packages/core/src/messages/tr.json': { a: 'y', c: 'y' },
      'apps/web/src/messages/en.json': { a: 'x' },
      'apps/web/src/messages/tr.json': {},
    });
    expect(checkI18nParity(root)).toEqual([
      { dir: 'apps/web/src/messages', ...empty, missing: { tr: ['a'] } },
      { dir: 'packages/core/src/messages', ...empty, missing: { en: ['c'], tr: ['b'] } },
    ]);
  });

  it('counts a missing required locale file as missing every key', () => {
    const root = repoWith({ 'apps/server/src/mail/messages/en.json': { a: 'x', b: { c: 'x' } } });
    expect(checkI18nParity(root)).toEqual([
      { dir: 'apps/server/src/mail/messages', ...empty, missing: { tr: ['a', 'b.c'] } },
    ]);
  });

  it('compares extra locale files and flags files that are not <locale>.json', () => {
    const root = repoWith({
      'apps/web/src/messages/en.json': { a: 'x' },
      'apps/web/src/messages/tr.json': { a: 'y' },
      'apps/web/src/messages/en-US.json': {},
      'apps/web/src/messages/tr.json5': {},
      'apps/web/src/messages/de.ts': '',
      'apps/web/src/messages/README.md': '',
    });
    expect(checkI18nParity(root)).toEqual([
      {
        dir: 'apps/web/src/messages',
        ...empty,
        unexpectedFiles: ['README.md', 'de.ts', 'tr.json5'],
        missing: { 'en-US': ['a'] },
      },
    ]);
  });

  it('checks nested namespaces inside a messages directory', () => {
    const root = repoWith({
      'apps/web/src/messages/auth/en.json': { a: 'x' },
      'apps/web/src/messages/auth/tr.json': {},
      'apps/web/src/messages/billing/deep/en.json': { b: 'x' },
      'apps/web/src/messages/billing/deep/tr.json': { b: 'y' },
    });
    expect(checkI18nParity(root)).toEqual([
      { dir: 'apps/web/src/messages/auth', ...empty, missing: { tr: ['a'] } },
    ]);
  });

  it('reports placeholder mismatches and invalid values', () => {
    const root = repoWith({
      'apps/server/src/mail/messages/en.json': { a: 'Hi {name}', b: 'x' },
      'apps/server/src/mail/messages/tr.json': { a: 'Merhaba', b: '' },
    });
    const [p] = checkI18nParity(root);
    expect(p?.placeholders).toEqual([{ key: 'a', byLocale: { en: ['name'], tr: [] } }]);
    expect(p?.invalid).toEqual({ tr: [{ key: 'b', reason: 'value is empty' }] });
    // An empty value is not a usable translation, so the key also counts as missing in tr.
    expect(p?.missing).toEqual({ tr: ['b'] });
  });

  it('ignores node_modules and build output, but not other public directories', () => {
    const root = repoWith({
      'apps/server/node_modules/x/messages/en.json': { a: 'x' },
      'apps/server/dist/messages/en.json': { a: 'x' },
      'apps/server/public/messages/en.json': { a: 'x' },
      'apps/web/public/locales/messages/en.json': { a: 'x' },
    });
    expect(checkI18nParity(root).map((p) => p.dir)).toEqual(['apps/web/public/locales/messages']);
  });

  it('names the file when a catalog is not valid JSON', () => {
    const root = repoWith({
      'apps/server/src/mail/messages/en.json': '{ "a": ',
      'apps/server/src/mail/messages/tr.json': { a: 'y' },
    });
    expect(() => checkI18nParity(root)).toThrow('apps/server/src/mail/messages/en.json');
  });

  it('passes on the repository itself', () => {
    expect(checkI18nParity(fileURLToPath(new URL('..', import.meta.url)))).toEqual([]);
  });
});

describe('formatProblems', () => {
  it('prints one line per locale, key or file under its catalog', () => {
    expect(
      formatProblems([
        {
          dir: 'apps/web/src/messages',
          unexpectedFiles: ['tr.json5'],
          missing: { en: ['c'], tr: ['a', 'b.c'] },
          placeholders: [{ key: 'g', byLocale: { en: ['name'], tr: [] } }],
          invalid: { tr: [{ key: 'h', reason: 'value is empty' }] },
        },
      ]),
    ).toEqual([
      'Translation catalogs disagree (every locale must define the same keys):',
      '  apps/web/src/messages',
      '    unexpected file tr.json5: only <locale>.json files belong in a messages directory',
      '    en.json is missing: c',
      '    tr.json is missing: a, b.c',
      '    placeholders differ for g: en {name}, tr {}',
      '    tr.json h: value is empty',
    ]);
  });
});

describe('main', () => {
  it('returns 0 and prints nothing when the catalogs agree', () => {
    const lines: string[] = [];
    const root = repoWith({
      'apps/x/messages/en.json': { a: 'x' },
      'apps/x/messages/tr.json': { a: 'y' },
    });
    expect(main(root, (l: string) => lines.push(l))).toBe(0);
    expect(lines).toEqual([]);
  });
});

describe('command line', () => {
  const broken = { 'apps/x/messages/en.json': { a: 'x' }, 'apps/x/messages/tr.json': {} };

  it('exits 1 and lists the missing keys on stderr', () => {
    const root = repoWith(broken);
    const run = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('tr.json is missing: a');
  });

  it('still runs when invoked through a symlink', () => {
    const root = repoWith(broken);
    const link = join(root, 'linked-check.mjs');
    symlinkSync(SCRIPT, link);
    const run = spawnSync(process.execPath, [link, root], { encoding: 'utf8' });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('tr.json is missing: a');
  });

  it('exits 0 on catalogs that agree', () => {
    const root = repoWith({
      'apps/x/messages/en.json': { a: 'x' },
      'apps/x/messages/tr.json': { a: 'y' },
    });
    const run = spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' });
    expect(run.status).toBe(0);
    expect(run.stderr).toBe('');
  });
});
