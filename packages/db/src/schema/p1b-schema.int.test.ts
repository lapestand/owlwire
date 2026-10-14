import { newId } from '@owlwire/core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { seedRawTenant } from '../__test__/raw-seed.js';

let env: DbTestEnv;
let app: pg.Pool;

beforeAll(async () => {
  env = await setupDbTestEnv();
  app = new pg.Pool({ connectionString: env.tdb.appUrl, max: 2 });
}, 120_000);
afterAll(async () => {
  await app?.end();
  await env?.stop();
});

const owner = (text: string, values: unknown[] = []) => env.owner.query(text, values);

async function createUser(): Promise<string> {
  const id = newId();
  await owner('insert into auth_user (id, name, email) values ($1, $2, $3)', [
    id,
    'User',
    `${id}@x.test`,
  ]);
  return id;
}

async function createWorkspace(
  kind: 'personal' | 'community',
  ownerUserId: string | null,
): Promise<string> {
  const id = newId();
  await owner(
    'insert into workspaces (id, name, slug, kind, owner_user_id) values ($1, $2, $3, $4, $5)',
    [id, 'W', `w-${id.replace(/-/g, '').slice(-12)}`, kind, ownerUserId],
  );
  return id;
}

async function invite(workspaceId: string, email: string, role = 'member'): Promise<void> {
  await owner(
    "insert into invitations (id, workspace_id, email, role, token_hash, expires_at) values ($1, $2, $3, $4, $5, now() + interval '7 days')",
    [newId(), workspaceId, email, role, `hash-${newId()}`],
  );
}

/** Uygulama rolüyle, verilen workspace GUC'u altında tek transaction'da sorgu çalıştırır. */
async function asTenant<T>(workspaceId: string | null, text: string): Promise<T[]> {
  const client = await app.connect();
  try {
    await client.query('begin');
    if (workspaceId)
      await client.query("select set_config('owlwire.workspace_id', $1, true)", [workspaceId]);
    const res = await client.query(text);
    await client.query('commit');
    return res.rows as T[];
  } finally {
    client.release();
  }
}

describe('auth, membership and invitation schema', () => {
  it('defaults is_instance_admin, two_factor_enabled and email_verified to false', async () => {
    const id = await createUser();
    const { rows } = await owner(
      'select is_instance_admin, two_factor_enabled, email_verified from auth_user where id = $1',
      [id],
    );
    expect(rows[0]).toEqual({
      is_instance_admin: false,
      two_factor_enabled: false,
      email_verified: false,
    });
  });

  it('stores Better Auth rate limit buckets with a unique key', async () => {
    const key = `203.0.113.7/sign-in/email-${newId()}`;
    await owner(
      'insert into auth_rate_limit (id, key, count, last_request) values ($1, $2, 1, $3)',
      [newId(), key, Date.now()],
    );
    await expect(
      owner('insert into auth_rate_limit (id, key, count, last_request) values ($1, $2, 1, $3)', [
        newId(),
        key,
        Date.now(),
      ]),
    ).rejects.toThrow();
    const { rows } = await owner(
      "select column_name, data_type from information_schema.columns where table_name = 'auth_rate_limit' order by column_name",
    );
    expect(rows).toEqual([
      { column_name: 'count', data_type: 'integer' },
      { column_name: 'id', data_type: 'uuid' },
      { column_name: 'key', data_type: 'text' },
      { column_name: 'last_request', data_type: 'bigint' },
    ]);
  });

  it('keeps one schema file per table behind the barrel', async () => {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(new URL('.', import.meta.url));
    expect(files).toEqual(
      expect.arrayContaining([
        'index.ts',
        'types.ts',
        'auth-user.ts',
        'auth-session.ts',
        'auth-account.ts',
        'auth-verification.ts',
        'auth-two-factor.ts',
        'auth-passkey.ts',
        'auth-rate-limit.ts',
        'memberships.ts',
        'invitations.ts',
      ]),
    );
    expect(files).not.toContain('auth.ts');
    expect(await readdir(new URL('..', import.meta.url))).not.toContain('schema.ts');
  });

  it('rejects an unknown membership role', async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace('community', null);
    await expect(
      owner("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'root')", [
        workspaceId,
        userId,
      ]),
    ).rejects.toThrow();
  });

  it('allows one personal workspace per owner but many community workspaces', async () => {
    const userId = await createUser();
    await createWorkspace('personal', userId);
    await expect(createWorkspace('personal', userId)).rejects.toThrow(
      /workspaces_personal_owner_uidx/,
    );
    await createWorkspace('community', null);
    await createWorkspace('community', null);
  });

  it('rejects the owner role, upper-case emails and duplicate token hashes in invitations', async () => {
    const workspaceId = await createWorkspace('community', null);
    await expect(invite(workspaceId, 'x@x.test', 'owner')).rejects.toThrow();
    await expect(invite(workspaceId, 'Upper@x.test')).rejects.toThrow();
    const values = [workspaceId, 'y@x.test', 'member', 'same-hash'];
    const insert = () =>
      owner(
        "insert into invitations (id, workspace_id, email, role, token_hash, expires_at) values ($1, $2, $3, $4, $5, now() + interval '7 days')",
        [newId(), ...values],
      );
    await insert();
    await expect(insert()).rejects.toThrow();
  });

  it('cascades memberships when the user is deleted', async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace('community', null);
    await owner("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')", [
      workspaceId,
      userId,
    ]);
    await owner('delete from auth_user where id = $1', [userId]);
    const { rows } = await owner('select 1 from memberships where workspace_id = $1', [
      workspaceId,
    ]);
    expect(rows).toHaveLength(0);
  });

  it('clears installations.created_by_user_id when the creating user is deleted', async () => {
    const userId = await createUser();
    const tenant = await seedRawTenant(env.owner, `auth-${newId().slice(-8)}`);
    await owner('update installations set created_by_user_id = $1 where id = $2', [
      userId,
      tenant.installationId,
    ]);
    await expect(
      owner('update installations set created_by_user_id = $1 where id = $2', [
        newId(),
        tenant.installationId,
      ]),
    ).rejects.toThrow();
    await owner('delete from auth_user where id = $1', [userId]);
    const { rows } = await owner('select created_by_user_id from installations where id = $1', [
      tenant.installationId,
    ]);
    expect(rows[0]).toEqual({ created_by_user_id: null });
  });

  it('isolates memberships and invitations per workspace through RLS', async () => {
    const userId = await createUser();
    const wsA = await createWorkspace('community', null);
    const wsB = await createWorkspace('community', null);
    for (const ws of [wsA, wsB]) {
      await owner(
        "insert into memberships (workspace_id, user_id, role) values ($1, $2, 'owner')",
        [ws, userId],
      );
      await invite(ws, `${newId()}@x.test`);
    }
    const members = await asTenant<{ workspace_id: string }>(
      wsA,
      'select workspace_id from memberships',
    );
    expect(members.length).toBeGreaterThan(0);
    expect(members.every((r) => r.workspace_id === wsA)).toBe(true);
    const invites = await asTenant<{ workspace_id: string }>(
      wsA,
      'select workspace_id from invitations',
    );
    expect(invites.every((r) => r.workspace_id === wsA)).toBe(true);
    expect(await asTenant(null, 'select 1 from memberships')).toHaveLength(0);
    expect(await asTenant(null, 'select 1 from invitations')).toHaveLength(0);
  });

  it('uses the tenant policy pattern without FORCE', async () => {
    const { rows: policies } = await owner(
      "select tablename, policyname from pg_policies where tablename in ('memberships', 'invitations') order by 1",
    );
    expect(policies).toEqual([
      { tablename: 'invitations', policyname: 'invitations_tenant_isolation' },
      { tablename: 'memberships', policyname: 'memberships_tenant_isolation' },
    ]);
    const { rows: flags } = await owner(
      "select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('memberships', 'invitations') order by 1",
    );
    expect(flags).toEqual([
      { relname: 'invitations', relrowsecurity: true, relforcerowsecurity: false },
      { relname: 'memberships', relrowsecurity: true, relforcerowsecurity: false },
    ]);
  });
});
