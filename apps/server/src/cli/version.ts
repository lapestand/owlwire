import { readFileSync } from 'node:fs';
import type { Command } from 'commander';

/** The `version` field of the package.json at `packageJson`. */
export function readPackageVersion(packageJson: URL): string {
  const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version?: unknown };
  if (typeof version !== 'string') throw new Error('package.json has no version');
  return version;
}

/** `-V, --version` prints the version and exits 0. */
export function addVersionOption(program: Command, version: string): Command {
  return program.version(version, '-V, --version', 'print the Owlwire version');
}
