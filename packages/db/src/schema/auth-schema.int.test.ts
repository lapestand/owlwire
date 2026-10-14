import { INVITABLE_ROLES, newId, WORKSPACE_ROLES } from '@owlwire/core';
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

async function invite(
  workspaceId: string,
  email: string,
  role = 'member',
  tokenHash = `hash-${newId()}`,
): Promise<string> {
  const id = newId();
  await owner(
    "insert into invitations (id, workspace_id, email, role, token_hash, expires_at) values ($1, $2, $3, $4, $5, now() + interval '7 days')",
    [id, workspaceId, email, role, tokenHash],
  );
  return id;
}

/** Asserts the statement fails with this SQLSTATE on this constraint (not just any error). */
async function rejectsWith(
  attempt: Promise<unknown>,
  code: '23001' | '23503' | '23505' | '23514',
  constraint: string,
): Promise<void> {
  await expect(attempt).rejects.toMatchObject({ code, constraint });
}

/** The quoted values of an `in (...)` CHECK, read back from the catalog. */
async function checkValues(constraint: string): Promise<string[]> {
  const { rows } = await owner(
    'select pg_get_constraintdef(oid) as def from pg_constraint where conname = $1',
    [constraint],
  );
  const def = String(rows[0]?.def ?? '');
  return [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1] ?? '');
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
    await rejectsWith(
      owner('insert into auth_rate_limit (id, key, count, last_request) values ($1, $2, 1, $3)', [
        newId(),
        key,
        Date.now(),
      ]),
      '23505',
      'auth_rate_limit_key_unique',
    );
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
    await rejectsWith(
      owner("insert into memberships (workspace_id, user_id, role) values ($1, $2, 'root')", [
        workspaceId,
        userId,
      ]),
      '23514',
      'memberships_role_check',
    );
  });

  it('derives the role check constraints from the core role lists', async () => {
    expect((await checkValues('memberships_role_check')).sort()).toEqual(
      [...WORKSPACE_ROLES].sort(),
    );
    expect((await checkValues('invitations_role_check')).sort()).toEqual(
      [...INVITABLE_ROLES].sort(),
    );
    expect((await checkValues('workspaces_kind_check')).sort()).toEqual(['community', 'personal']);
  });

  it('allows one live personal workspace per owner but many community workspaces', async () => {
    const userId = await createUser();
    const first = await createWorkspace('personal', userId);
    await rejectsWith(
      createWorkspace('personal', userId),
      '23505',
      'workspaces_personal_owner_uidx',
    );
    await createWorkspace('community', null);
    await createWorkspace('community', null);
    // A soft-deleted personal workspace no longer counts, so a new one can be created.
    await owner('update workspaces set deleted_at = now() where id = $1', [first]);
    await createWorkspace('personal', userId);
  });

  it('allows an owner only on personal workspaces', async () => {
    const userId = await createUser();
    await rejectsWith(createWorkspace('community', userId), '23514', 'workspaces_owner_kind_check');
    await createWorkspace('personal', null);
  });

  it('refuses to delete a user who still owns a personal workspace', async () => {
    const userId = await createUser();
    const workspaceId = await createWorkspace('personal', userId);
    await rejectsWith(
      owner('delete from auth_user where id = $1', [userId]),
      // ON DELETE RESTRICT reports restrict_violation, not the 23503 of NO ACTION.
      '23001',
      'workspaces_owner_user_id_auth_user_id_fk',
    );
    await owner('delete from workspaces where id = $1', [workspaceId]);
    await owner('delete from auth_user where id = $1', [userId]);
  });

  it('rejects upper-case user emails', async () => {
    await rejectsWith(
      owner('insert into auth_user (id, name, email) values ($1, $2, $3)', [
        newId(),
        'User',
        `Upper-${newId()}@x.test`,
      ]),
      '23514',
      'auth_user_email_lower_check',
    );
  });

  it('rejects the owner role, upper-case emails and duplicate token hashes in invitations', async () => {
    const workspaceId = await createWorkspace('community', null);
    await rejectsWith(
      invite(workspaceId, `${newId()}@x.test`, 'owner'),
      '23514',
      'invitations_role_check',
    );
    await rejectsWith(
      invite(workspaceId, `Upper-${newId()}@x.test`),
      '23514',
      'invitations_email_lower_check',
    );
    const tokenHash = `same-${newId()}`;
    await invite(workspaceId, `${newId()}@x.test`, 'member', tokenHash);
    await rejectsWith(
      invite(workspaceId, `${newId()}@x.test`, 'member', tokenHash),
      '23505',
      'invitations_token_hash_unique',
    );
  });

  it('allows one open invitation per address and workspace', async () => {
    const wsA = await createWorkspace('community', null);
    const wsB = await createWorkspace('community', null);
    const email = `${newId()}@x.test`;
    const first = await invite(wsA, email);
    await rejectsWith(invite(wsA, email, 'admin'), '23505', 'invitations_pending_email_uidx');
    // Another workspace may invite the same address.
    await invite(wsB, email);
    // Once accepted, the row no longer blocks a new invitation.
    await owner('update invitations set accepted_at = now() where id = $1', [first]);
    await invite(wsA, email);
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
    await rejectsWith(
      owner('update installations set created_by_user_id = $1 where id = $2', [
        newId(),
        tenant.installationId,
      ]),
      '23503',
      'installations_created_by_user_id_auth_user_id_fk',
    );
    await owner('delete from auth_user where id = $1', [userId]);
    const { rows } = await owner('select created_by_user_id from installations where id = $1', [
      tenant.installationId,
    ]);
    expect(rows[0]).toEqual({ created_by_user_id: null });
  });

  it('rejects a second passkey with the same credential id and a second two-factor row per user', async () => {
    const userId = await createUser();
    const credentialId = `cred-${newId()}`;
    const passkey = () =>
      owner(
        "insert into auth_passkey (id, public_key, user_id, credential_id, counter, device_type, backed_up) values ($1, 'pk', $2, $3, 0, 'singleDevice', false)",
        [newId(), userId, credentialId],
      );
    await passkey();
    await rejectsWith(passkey(), '23505', 'auth_passkey_credential_id_unique');
    const factor = () =>
      owner(
        "insert into auth_two_factor (id, secret, backup_codes, user_id) values ($1, 'enc', 'enc', $2)",
        [newId(), userId],
      );
    await factor();
    await rejectsWith(factor(), '23505', 'auth_two_factor_user_id_unique');
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
    for (const table of ['memberships', 'invitations']) {
      const rows = await asTenant<{ workspace_id: string }>(
        wsA,
        `select workspace_id from ${table}`,
      );
      // Positive control first: the tenant sees its own rows, so the next check cannot pass vacuously.
      expect(
        rows.some((r) => r.workspace_id === wsA),
        table,
      ).toBe(true);
      expect(
        rows.every((r) => r.workspace_id === wsA),
        table,
      ).toBe(true);
      expect(await asTenant(null, `select 1 from ${table}`), table).toHaveLength(0);
    }
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
