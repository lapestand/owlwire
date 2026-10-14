import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkI18nParity,
  findMissingKeys,
  flattenKeys,
  formatProblems,
} from './check-i18n-parity.mjs';

function repoWith(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'i18n-parity-'));
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

describe('flattenKeys', () => {
  it('flattens nested objects to sorted dotted keys', () => {
    expect(flattenKeys({ b: 'x', a: { d: 'y', c: { e: 'z' } } })).toEqual(['a.c.e', 'a.d', 'b']);
  });

  it('treats arrays and other non-object values as leaves', () => {
    expect(flattenKeys({ list: ['a'], n: 1, nil: null })).toEqual(['list', 'n', 'nil']);
  });
});

describe('findMissingKeys', () => {
  it('returns nothing when the locales define the same keys', () => {
    expect(findMissingKeys({ en: { a: { b: 'x' } }, tr: { a: { b: 'y' } } })).toEqual({});
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
      { dir: 'apps/web/src/messages', missing: { tr: ['a'] } },
      { dir: 'packages/core/src/messages', missing: { en: ['c'], tr: ['b'] } },
    ]);
  });

  it('counts a missing locale file as missing every key', () => {
    const root = repoWith({ 'apps/server/src/mail/messages/en.json': { a: 'x', b: { c: 'x' } } });
    expect(checkI18nParity(root)).toEqual([
      { dir: 'apps/server/src/mail/messages', missing: { tr: ['a', 'b.c'] } },
    ]);
  });

  it('ignores node_modules and build output', () => {
    const root = repoWith({
      'apps/server/node_modules/x/messages/en.json': { a: 'x' },
      'apps/server/dist/messages/en.json': { a: 'x' },
    });
    expect(checkI18nParity(root)).toEqual([]);
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
  it('prints one line per locale under its catalog', () => {
    expect(
      formatProblems([{ dir: 'apps/web/src/messages', missing: { en: ['c'], tr: ['a', 'b.c'] } }]),
    ).toEqual([
      'Translation keys missing (every locale must define the same keys):',
      '  apps/web/src/messages',
      '    en.json is missing: c',
      '    tr.json is missing: a, b.c',
    ]);
  });
});
