import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST,
  checkEnv,
  composeVariables,
  envFileKeys,
  processEnvReads,
  schemaKeys,
} from './check-env.mjs';

const LOADER = `import { z } from 'zod';

const envSchema = z.object({
  OWLWIRE_DATABASE_URL: z.string(),
  OWLWIRE_PORT: z.coerce.number().default(8080),
  'OWLWIRE_QUOTED': z.string().optional(),
});

export function loadConfig(env) {
  // OWLWIRE_NOT_A_KEY only appears in a comment and a message.
  return envSchema.parse(env, { error: () => 'OWLWIRE_ALSO_NOT_A_KEY' });
}
`;

const EXAMPLE = `# Database
OWLWIRE_DB_PASSWORD=
OWLWIRE_PORT=8080
OWLWIRE_QUOTED=x
`;

const COMPOSE = `services:
  owlwire:
    env_file: .env
    environment:
      OWLWIRE_DATABASE_URL: postgres://app:\${OWLWIRE_DB_PASSWORD:?set it}@postgres/owlwire
`;

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'env-check-'));
  const all = {
    'apps/server/src/config/load.ts': LOADER,
    'deploy/compose/.env.example': EXAMPLE,
    'deploy/compose/docker-compose.yml': COMPOSE,
    ...files,
  };
  for (const [rel, text] of Object.entries(all)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

describe('schemaKeys', () => {
  it('returns the keys of the envSchema object only', () => {
    expect(schemaKeys(LOADER)).toEqual(['OWLWIRE_DATABASE_URL', 'OWLWIRE_PORT', 'OWLWIRE_QUOTED']);
  });

  it('throws when the loader has no envSchema', () => {
    expect(() => schemaKeys('export const x = 1;\n')).toThrow(/envSchema/);
  });
});

describe('processEnvReads', () => {
  it('finds member, optional, bracket and destructured reads', () => {
    const text = [
      'const a = process.env.OWLWIRE_A;',
      'const b = process.env?.OWLWIRE_B;',
      "const c = process.env['OWLWIRE_C'];",
      'const d = process.env["OWLWIRE_D"];',
      'const { OWLWIRE_E, OWLWIRE_F: f, HOME } = process.env;',
    ].join('\n');
    expect(processEnvReads(text).sort()).toEqual([
      'OWLWIRE_A',
      'OWLWIRE_B',
      'OWLWIRE_C',
      'OWLWIRE_D',
      'OWLWIRE_E',
      'OWLWIRE_F',
    ]);
  });

  it('ignores other variables and OWLWIRE_ names outside process.env', () => {
    const text = [
      'const n = process.env.NODE_ENV;',
      "const msg = 'set OWLWIRE_KEK';",
      'const v = env.OWLWIRE_KEK;',
      "const prefix = key.startsWith('OWLWIRE_');",
    ].join('\n');
    expect(processEnvReads(text)).toEqual([]);
  });
});

describe('envFileKeys', () => {
  it('lists assigned names and skips comments, including commented-out assignments', () => {
    const text = '# OWLWIRE_OLD=1\nOWLWIRE_A=\n  OWLWIRE_B=x\nexport OWLWIRE_C=y\nOTHER=1\n\n';
    expect(envFileKeys(text)).toEqual(['OWLWIRE_A', 'OWLWIRE_B', 'OWLWIRE_C']);
  });
});

describe('composeVariables', () => {
  it('separates environment keys from interpolated names', () => {
    const text = `${COMPOSE}      - OWLWIRE_LIST_FORM=1\n      PORT: $OWLWIRE_BARE\n`;
    expect(composeVariables(text)).toEqual({
      provided: ['OWLWIRE_DATABASE_URL', 'OWLWIRE_LIST_FORM'],
      interpolated: ['OWLWIRE_DB_PASSWORD', 'OWLWIRE_BARE'],
    });
  });
});

describe('checkEnv', () => {
  it('passes when the code, the compose file and .env.example agree', () => {
    expect(checkEnv(repoWith({}))).toEqual({ missing: [], unused: [] });
  });

  it('reports a schema key missing from .env.example', () => {
    const root = repoWith({
      'deploy/compose/.env.example': 'OWLWIRE_DB_PASSWORD=\nOWLWIRE_PORT=\n',
    });
    expect(checkEnv(root)).toEqual({
      missing: [{ name: 'OWLWIRE_QUOTED', files: ['apps/server/src/config/load.ts'] }],
      unused: [],
    });
  });

  it('reports a process.env read outside the loader, with every file that reads it', () => {
    const root = repoWith({
      'packages/db/src/x.ts': 'export const x = process.env.OWLWIRE_EXTRA;\n',
      'apps/server/src/y.ts': "export const y = process.env['OWLWIRE_EXTRA'];\n",
    });
    expect(checkEnv(root).missing).toEqual([
      { name: 'OWLWIRE_EXTRA', files: ['apps/server/src/y.ts', 'packages/db/src/x.ts'] },
    ]);
  });

  it('reports a variable in .env.example that nothing reads', () => {
    const root = repoWith({ 'deploy/compose/.env.example': `${EXAMPLE}OWLWIRE_GONE=1\n` });
    expect(checkEnv(root)).toEqual({ missing: [], unused: ['OWLWIRE_GONE'] });
  });

  it('accepts a variable the compose file sets, and one it interpolates', () => {
    const root = repoWith({ 'deploy/compose/docker-compose.yml': 'services: {}\n' });
    expect(checkEnv(root)).toEqual({
      missing: [{ name: 'OWLWIRE_DATABASE_URL', files: ['apps/server/src/config/load.ts'] }],
      unused: ['OWLWIRE_DB_PASSWORD'],
    });
  });

  it('skips allowlisted variables in both directions', () => {
    const root = repoWith({
      'packages/testing/src/setup.ts': 'export const i = process.env.OWLWIRE_TEST_ONLY;\n',
      'deploy/compose/.env.example': `${EXAMPLE}OWLWIRE_DEV_ONLY=\n`,
    });
    const allowlist = new Map([
      ['OWLWIRE_TEST_ONLY', 'test'],
      ['OWLWIRE_DEV_ONLY', 'dev'],
    ]);
    expect(checkEnv(root, allowlist)).toEqual({ missing: [], unused: [] });
    expect(checkEnv(root, new Map())).toEqual({
      missing: [{ name: 'OWLWIRE_TEST_ONLY', files: ['packages/testing/src/setup.ts'] }],
      unused: ['OWLWIRE_DEV_ONLY'],
    });
  });

  it('ignores test files, build output and dependencies', () => {
    const read = 'export const v = process.env.OWLWIRE_HIDDEN;\n';
    const root = repoWith({
      'apps/server/src/a.test.ts': read,
      'apps/server/src/b.int.test.ts': read,
      'apps/server/dist/main.js': read,
      'apps/server/public/assets/index.js': read,
      'packages/db/node_modules/dep/index.js': read,
      'scripts/tool.test.ts': read,
    });
    expect(checkEnv(root)).toEqual({ missing: [], unused: [] });
  });

  it('scans scripts as well as apps and packages', () => {
    const root = repoWith({ 'scripts/tool.mjs': 'const v = process.env.OWLWIRE_SCRIPT;\n' });
    expect(checkEnv(root).missing.map((m) => m.name)).toEqual(['OWLWIRE_SCRIPT']);
  });
});

describe('ALLOWLIST', () => {
  it('gives a reason for every entry', () => {
    for (const [name, reason] of ALLOWLIST) {
      expect(name).toMatch(/^OWLWIRE_/);
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});
