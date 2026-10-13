import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { type OwlwireDb, openDatabase } from '../handle.js';
import { SYSTEM } from '../scope.js';
import { checkRlsEnforcement } from './startup.js';

let env: DbTestEnv;
const opened: OwlwireDb[] = [];
const suffix = randomBytes(4).toString('hex');

function openAs(user: string, password: string): OwlwireDb {
  const url = new URL(env.tdb.appUrl);
  url.username = user;
  url.password = password;
  const db = openDatabase({ url: url.toString(), keyring: env.keyring, clock: env.clock });
  opened.push(db);
  return db;
}

beforeAll(async () => {
  env = await setupDbTestEnv();
}, 120_000);

afterAll(async () => {
  for (const db of opened) await db.close();
  await env?.stop();
});

describe('checkRlsEnforcement (startup, same check as ensureAppRole)', () => {
  it('passes for the dedicated application role', async () => {
    await expect(checkRlsEnforcement(SYSTEM, env.db)).resolves.toEqual({
      enforced: true,
      reasons: [],
    });
  });

  it('refuses a role that can SET ROLE to a BYPASSRLS role through membership', async () => {
    const group = `st_bypass_grp_${suffix}`;
    const member = `st_bypass_member_${suffix}`;
    await env.owner.query(`create role ${group} nologin bypassrls`);
    await env.owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await env.owner.query(`grant ${group} to ${member}`);
    const result = await checkRlsEnforcement(SYSTEM, openAs(member, 'x'));
    expect(result.enforced).toBe(false);
    expect(result.reasons).toEqual([
      'application role is a member of a SUPERUSER or BYPASSRLS role',
    ]);
  });

  it('refuses a role that is a member of a non-owner superuser role', async () => {
    const group = `st_su_grp_${suffix}`;
    const member = `st_su_member_${suffix}`;
    await env.owner.query(`create role ${group} nologin superuser`);
    await env.owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await env.owner.query(`grant ${group} to ${member}`);
    const result = await checkRlsEnforcement(SYSTEM, openAs(member, 'x'));
    expect(result.enforced).toBe(false);
    expect(result.reasons).toContain(
      'application role is a member of a SUPERUSER or BYPASSRLS role',
    );
  });

  it('refuses a role that owns an application relation other than workspaces', async () => {
    const tableOwner = `st_table_owner_${suffix}`;
    const table = `st_owned_${suffix}`;
    await env.owner.query(`create role ${tableOwner} login password 'x' nosuperuser nobypassrls`);
    await env.owner.query(`create table public.${table} (id int)`);
    await env.owner.query(`alter table public.${table} owner to ${tableOwner}`);
    try {
      const result = await checkRlsEnforcement(SYSTEM, openAs(tableOwner, 'x'));
      expect(result.enforced).toBe(false);
      expect(result.reasons).toEqual(['application role owns the tables']);
    } finally {
      await env.owner.query(`drop table public.${table}`);
    }
  });

  it('refuses a role that owns a graphile_worker relation through membership', async () => {
    const group = `st_rel_grp_${suffix}`;
    const member = `st_rel_member_${suffix}`;
    const table = `st_grp_owned_${suffix}`;
    await env.owner.query(`create role ${group} nologin nosuperuser nobypassrls`);
    await env.owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await env.owner.query(`grant ${group} to ${member}`);
    await env.owner.query(`create table graphile_worker.${table} (id int)`);
    await env.owner.query(`alter table graphile_worker.${table} owner to ${group}`);
    try {
      const result = await checkRlsEnforcement(SYSTEM, openAs(member, 'x'));
      expect(result.enforced).toBe(false);
      expect(result.reasons).toEqual([
        'application role is a member of a role that owns the tables',
      ]);
    } finally {
      await env.owner.query(`drop table graphile_worker.${table}`);
    }
  });

  it('refuses when a workspace table has RLS disabled', async () => {
    const table = `st_no_rls_${suffix}`;
    await env.owner.query(`create table public.${table} (id int, workspace_id uuid not null)`);
    try {
      const result = await checkRlsEnforcement(SYSTEM, env.db);
      expect(result.enforced).toBe(false);
      expect(result.reasons).toEqual([`RLS is not enabled on ${table}`]);
    } finally {
      await env.owner.query(`drop table public.${table}`);
    }
  });

  it.each(['workspaces', 'apps', 'instance_settings'])(
    'refuses when RLS is disabled on the policy bearing table %s',
    async (table) => {
      await env.owner.query(`alter table public.${table} disable row level security`);
      try {
        const result = await checkRlsEnforcement(SYSTEM, env.db);
        expect(result.enforced).toBe(false);
        expect(result.reasons).toEqual([`RLS is not enabled on ${table}`]);
      } finally {
        await env.owner.query(`alter table public.${table} enable row level security`);
      }
    },
  );
});
