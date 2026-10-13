import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bumpAll, listPackageJsonFiles, nextVersion } from './bump-version.mjs';

function writePkg(dir: string, body: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), body);
}

describe('nextVersion', () => {
  it('bumps patch, minor and major', () => {
    expect(nextVersion('0.1.2', 'patch')).toBe('0.1.3');
    expect(nextVersion('0.1.2', 'minor')).toBe('0.2.0');
    expect(nextVersion('0.1.2', 'major')).toBe('1.0.0');
  });

  it('rejects unknown kinds and malformed versions', () => {
    expect(() => nextVersion('0.1.2', 'huge')).toThrow(/invalid bump kind/);
    expect(() => nextVersion('banana', 'patch')).toThrow(/invalid version/);
  });
});

describe('bumpAll', () => {
  it('sets every workspace package.json to the same next version and keeps formatting', () => {
    const root = mkdtempSync(join(tmpdir(), 'bump-'));
    writePkg(root, '{\n  "name": "owlwire",\n  "version": "0.3.1",\n  "private": true\n}\n');
    writePkg(join(root, 'apps/server'), '{ "name": "@owlwire/server", "version": "0.0.0" }\n');
    writePkg(
      join(root, 'packages/core'),
      '{\n  "name": "@owlwire/core",\n  "version": "0.3.0"\n}\n',
    );
    writePkg(
      join(root, 'packages/adapters/telegram'),
      '{ "version": "0.1.0", "files": ["dist"] }\n',
    );
    mkdirSync(join(root, 'packages/empty'), { recursive: true });

    expect(listPackageJsonFiles(root)).toHaveLength(4);
    expect(bumpAll(root, 'minor')).toBe('0.4.0');

    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(
      '{\n  "name": "owlwire",\n  "version": "0.4.0",\n  "private": true\n}\n',
    );
    expect(readFileSync(join(root, 'apps/server/package.json'), 'utf8')).toBe(
      '{ "name": "@owlwire/server", "version": "0.4.0" }\n',
    );
    expect(readFileSync(join(root, 'packages/adapters/telegram/package.json'), 'utf8')).toBe(
      '{ "version": "0.4.0", "files": ["dist"] }\n',
    );
  });

  it('fails loudly when a package.json has no version field', () => {
    const root = mkdtempSync(join(tmpdir(), 'bump-'));
    writePkg(root, '{ "version": "0.1.0" }\n');
    writePkg(join(root, 'packages/core'), '{ "name": "@owlwire/core" }\n');
    expect(() => bumpAll(root, 'patch')).toThrow(/no "version" field/);
  });
});
