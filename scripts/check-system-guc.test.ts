import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSystemGucWrites } from './check-system-guc.mjs';

function repoWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'guc-check-'));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return root;
}

const ENABLE = "await client.query(\"select set_config('owlwire.system', 'on', true)\");\n";
const READ = "sql`select coalesce(current_setting('owlwire.system', true), '') as sys`;\n";
const CLEAR =
  "sql`select set_config('owlwire.workspace_id', $1, true), set_config('owlwire.system', '', true)`;\n";

describe('findSystemGucWrites', () => {
  it('flags a write that enables system mode in a forbidden file, with its line', () => {
    const root = repoWith({ 'apps/server/src/http/leak.ts': `// header\n${ENABLE}` });
    expect(findSystemGucWrites(root)).toEqual([{ file: 'apps/server/src/http/leak.ts', line: 2 }]);
  });

  it('flags SET statements and parameterised values outside the allowed files', () => {
    const root = repoWith({
      'packages/db/src/repos/x.ts': "sql`set local owlwire.system = 'on'`;\n",
      'packages/db/drizzle/0099_bad.sql': "ALTER DATABASE owlwire SET owlwire.system TO 'on';\n",
      'apps/server/src/worker/y.ts':
        'c.query("select set_config(\'owlwire.system\', $1, true)", [v]);\n',
      'apps/server/src/worker/z.ts':
        "c.query('select set_config(\\'owlwire.system\\', \\'on\\', true)');\n",
    });
    expect(findSystemGucWrites(root).map((o) => o.file)).toEqual([
      'apps/server/src/worker/y.ts',
      'apps/server/src/worker/z.ts',
      'packages/db/drizzle/0099_bad.sql',
      'packages/db/src/repos/x.ts',
    ]);
  });

  it('passes a read of the setting in any file', () => {
    const root = repoWith({
      'apps/server/src/http/read.ts': READ,
      'packages/db/drizzle/0002_rls_policies.sql':
        "SELECT coalesce(current_setting('owlwire.system', true), '') = 'on'\n",
    });
    expect(findSystemGucWrites(root)).toEqual([]);
  });

  it('passes the clearing form in scope.ts', () => {
    const root = repoWith({ 'packages/db/src/scope.ts': CLEAR });
    expect(findSystemGucWrites(root)).toEqual([]);
  });

  it('allows enabling only in scope.ts and db integration tests', () => {
    const root = repoWith({
      'packages/db/src/scope.ts': ENABLE,
      'packages/db/src/rls.int.test.ts': ENABLE,
      'packages/db/src/repos/audit.int.test.ts': ENABLE,
      'apps/server/src/system/system.int.test.ts': ENABLE,
    });
    expect(findSystemGucWrites(root)).toEqual([
      { file: 'apps/server/src/system/system.int.test.ts', line: 1 },
    ]);
  });

  it('scans deploy/ and docker/ scripts, sql, compose files and the Dockerfile', () => {
    const root = repoWith({
      'deploy/compose/initdb/10-app-role.sh':
        'psql -c "ALTER ROLE owlwire_app SET owlwire.system = \'on\'"\n',
      'deploy/compose/initdb/20-bad.sql': "SET owlwire.system = 'on';\n",
      'deploy/compose/docker-compose.yml':
        "    environment:\n      PGOPTIONS: '-c owlwire.system=on'\n",
      'docker/Dockerfile': 'ENV PGOPTIONS="-c owlwire.system=on"\n',
      'docker/entrypoint.sh': "echo ok\nselect current_setting('owlwire.system', true)\n",
      'deploy/compose/UPGRADING.md': "SET owlwire.system = 'on'\n",
    });
    expect(findSystemGucWrites(root)).toEqual([
      { file: 'deploy/compose/docker-compose.yml', line: 2 },
      { file: 'deploy/compose/initdb/10-app-role.sh', line: 1 },
      { file: 'deploy/compose/initdb/20-bad.sql', line: 1 },
      { file: 'docker/Dockerfile', line: 1 },
    ]);
  });

  it('skips dependencies and build output', () => {
    const root = repoWith({
      'packages/db/node_modules/x/index.js': ENABLE,
      'packages/db/dist/scope.js': ENABLE,
      'apps/server/drizzle/0099_copy.sql': "SET owlwire.system = 'on';\n",
    });
    expect(findSystemGucWrites(root)).toEqual([]);
  });
});
