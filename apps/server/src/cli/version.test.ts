import { readFileSync } from 'node:fs';
import { Command, CommanderError } from 'commander';
import { describe, expect, it } from 'vitest';
import { addVersionOption, readPackageVersion } from './version.js';

const packageJson = new URL('../../package.json', import.meta.url);

describe('owlwire --version', () => {
  it('reads the server package version', () => {
    const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
    expect(readPackageVersion(packageJson)).toBe(version);
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('prints the version and exits 0', async () => {
    const written: string[] = [];
    const program = new Command().name('owlwire').exitOverride();
    program.configureOutput({
      writeOut: (s) => void written.push(s),
      writeErr: (s) => void written.push(s),
    });
    addVersionOption(program, '1.2.3');
    const err = await program.parseAsync(['node', 'owlwire', '--version']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CommanderError);
    expect((err as CommanderError).exitCode).toBe(0);
    expect(written.join('')).toBe('1.2.3\n');
  });
});
