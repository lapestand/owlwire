import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@owlwire/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { createApp } from '../repos/apps.js';
import { SYSTEM_ACTOR } from '../repos/audit.js';
import { tenantScope, withTenant } from '../scope.js';

let env: DbTestEnv;

beforeAll(async () => {
  env = await setupDbTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

describe('app key and generic catalog migrations', () => {
  it('adds previous app key columns', async () => {
    const { rows } = await env.owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
       where table_name = 'apps' and column_name like 'app_key_prev%' order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'app_key_prev_expires_at',
      'app_key_prev_hash',
      'app_key_prev_prefix',
    ]);
  });

  it('enforces unique app key hashes', async () => {
    const ws = await createTestWorkspace(env.db, 'alpha');
    const insert = (slug: string) =>
      env.owner.query(
        `insert into apps (id, owner_workspace_id, name, slug, visibility, app_key_hash)
         values ($1, $2, 'a', $3, 'public', 'same-hash')`,
        [newId(), ws, slug],
      );
    await insert(`a-${newId().slice(-12)}`);
    await expect(insert(`a-${newId().slice(-12)}`)).rejects.toThrow(/apps_app_key_hash_uq/);
  });

  it('backfills the generic catalog type idempotently', async () => {
    const ws = await createTestWorkspace(env.db, 'bravo');
    const appId = newId();
    await env.owner.query(
      `insert into apps (id, owner_workspace_id, name, slug, visibility) values ($1, $2, 'b', $3, 'private')`,
      [appId, ws, `b-${appId.slice(-12)}`],
    );
    const dir = join(import.meta.dirname, '..', '..', 'drizzle');
    const file = readdirSync(dir).find((f) => f.endsWith('_generic_catalog.sql'));
    expect(file).toBeDefined();
    const sqlText = readFileSync(join(dir, file as string), 'utf8');
    await env.owner.query(sqlText);
    await env.owner.query(sqlText);
    const { rows } = await env.owner.query<{ key: string; default_severity: string }>(
      `select key, default_severity from catalog_types where app_id = $1`,
      [appId],
    );
    expect(rows).toEqual([{ key: 'generic', default_severity: 'info' }]);
  });

  it('never exposes the previous app key hash through AppRow', async () => {
    const ws = await createTestWorkspace(env.db, 'charlie');
    const app = await withTenant(env.db, tenantScope(ws), (t) =>
      createApp(
        t,
        { name: 'Hidden', slug: `hidden-${newId().slice(-12)}`, visibility: 'public' },
        SYSTEM_ACTOR,
      ),
    );
    expect(Object.keys(app)).not.toContain('appKeyPrevHash');
    expect(Object.keys(app)).not.toContain('appKeyHash');
  });
});
