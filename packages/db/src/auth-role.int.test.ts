import { randomBytes } from 'node:crypto';
import { FakeClock, newId } from '@owlwire/core';
import { createKeyring, generateKek } from '@owlwire/crypto';
import {
  startTestDatabase,
  TEST_APP,
  TEST_AUTH,
  TEST_OWNER,
  type TestDatabase,
} from '@owlwire/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_AUTH_USER_COLUMNS, AUTH_SECRET_TABLES, AUTH_TABLES } from './auth-tables.js';
import { type OwlwireDb, openDatabase } from './handle.js';
import { migrateAll } from './migrate-all.js';
import { AppRoleError, ensureAuthRole } from './roles.js';
import { SYSTEM } from './scope.js';
import { checkAuthRoleSeparation } from './system/startup.js';

let tdb: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let auth: pg.Pool;
const opened: OwlwireDb[] = [];
const suffix = randomBytes(4).toString('hex');

const urlAs = (base: string, user: string, password: string) => {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  return u.toString();
};

const open = (url: string): OwlwireDb => {
  const db = openDatabase({
    url,
    keyring: createKeyring(generateKek(1)),
    clock: new FakeClock(new Date('2026-10-15T09:00:00Z')),
  });
  opened.push(db);
  return db;
};

async function insertUser(): Promise<string> {
  const id = newId();
  await owner.query('insert into auth_user (id, name, email) values ($1, $2, $3)', [
    id,
    'Role Test',
    `role-${id}@x.test`,
  ]);
  return id;
}

/** Runs fn with a grant to the app role in place, and always takes it back (other tests see the clean state). */
async function withAppGrant(grant: string, revoke: string, fn: () => Promise<void>): Promise<void> {
  await owner.query(grant);
  try {
    await fn();
  } finally {
    await owner.query(revoke);
  }
}

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
  app = new pg.Pool({ connectionString: tdb.appUrl });
  auth = new pg.Pool({ connectionString: tdb.authUrl });
}, 120_000);

afterAll(async () => {
  for (const db of opened) await db.close();
  await auth?.end();
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

describe('application role on the auth tables', () => {
  it.each(AUTH_SECRET_TABLES)('gets 42501 reading %s', async (table) => {
    await expect(app.query(`select * from ${table} limit 1`)).rejects.toMatchObject({
      code: '42501',
    });
  });

  it.each(AUTH_SECRET_TABLES)('gets 42501 writing %s', async (table) => {
    await expect(app.query(`delete from ${table}`)).rejects.toMatchObject({ code: '42501' });
  });

  it('reads only the listed auth_user columns', async () => {
    const id = await insertUser();
    const cols = APP_AUTH_USER_COLUMNS.join(', ');
    const { rows } = await app.query(`select ${cols} from auth_user where id = $1`, [id]);
    expect(rows).toEqual([{ id, name: 'Role Test', email: `role-${id}@x.test`, image: null }]);
    for (const hidden of ['is_instance_admin', 'two_factor_enabled', 'email_verified', '*']) {
      await expect(app.query(`select ${hidden} from auth_user limit 1`)).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('cannot write auth_user, so it cannot make itself an instance admin', async () => {
    const id = await insertUser();
    await expect(
      app.query('update auth_user set is_instance_admin = true where id = $1', [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query("insert into auth_user (id, name, email) values ($1, 'x', $2)", [
        newId(),
        `x-${newId()}@x.test`,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(app.query('delete from auth_user where id = $1', [id])).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('still lets tenant rows reference users (foreign key checks run as the table owner)', async () => {
    const id = await insertUser();
    const client = await app.connect();
    try {
      await client.query('begin');
      await client.query("select set_config('owlwire.system', 'on', true)");
      const ws = newId();
      await client.query(
        "insert into workspaces (id, name, slug, kind, owner_user_id) values ($1, 'Fk', $2, 'personal', $3)",
        [ws, `fk-${ws}`, id],
      );
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('auth role', () => {
  it('connects as a non-superuser without BYPASSRLS that owns nothing', async () => {
    const { rows } = await auth.query<{ user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'select current_user as user, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user',
    );
    expect(rows[0]).toEqual({ user: TEST_AUTH.user, rolsuper: false, rolbypassrls: false });
    const owned = await owner.query(
      "select 1 from pg_tables where schemaname = 'public' and tableowner = $1",
      [TEST_AUTH.user],
    );
    expect(owned.rowCount).toBe(0);
  });

  it.each(AUTH_TABLES)('has full DML on %s', async (table) => {
    const { rows } = await auth.query<Record<string, boolean>>(
      `select has_table_privilege(current_user, $1, 'SELECT') as s,
              has_table_privilege(current_user, $1, 'INSERT') as i,
              has_table_privilege(current_user, $1, 'UPDATE') as u,
              has_table_privilege(current_user, $1, 'DELETE') as d`,
      [`public.${table}`],
    );
    expect(rows[0]).toEqual({ s: true, i: true, u: true, d: true });
  });

  it('cannot read tenant tables, even in system scope', async () => {
    for (const table of ['workspaces', 'connections', 'memberships', 'invitations', 'audit_log']) {
      await expect(auth.query(`select 1 from ${table} limit 1`)).rejects.toMatchObject({
        code: '42501',
      });
    }
  });

  it('can append an instance-level audit row in system scope, and only there', async () => {
    const client = await auth.connect();
    try {
      await client.query('begin');
      const insert = () =>
        client.query(
          `insert into audit_log (id, workspace_id, action, target_type, target_id, data)
           values ($1, null, 'instance.admin_granted', 'instance', $2, '{}')`,
          [newId(), newId()],
        );
      await expect(insert()).rejects.toMatchObject({ code: '42501' });
      await client.query('rollback');
      await client.query('begin');
      await client.query("select set_config('owlwire.system', 'on', true)");
      await expect(insert()).resolves.toMatchObject({ rowCount: 1 });
      await client.query('rollback');
    } finally {
      client.release();
    }
  });
});

describe('ensureAuthRole', () => {
  it('refuses the application role as the auth role', async () => {
    await expect(ensureAuthRole(tdb.ownerUrl, tdb.appUrl, tdb.appUrl)).rejects.toThrow(
      /must be a separate role/,
    );
  });

  it('returns "same" when the auth URL names the owner (single-role development)', async () => {
    await expect(ensureAuthRole(tdb.ownerUrl, tdb.ownerUrl, tdb.appUrl)).resolves.toBe('same');
  });

  it('refuses a BYPASSRLS role', async () => {
    const evil = `evil_auth_${suffix}`;
    await owner.query(`create role ${evil} login password 'x' bypassrls`);
    const result = ensureAuthRole(tdb.ownerUrl, urlAs(tdb.authUrl, evil, 'x'), tdb.appUrl);
    await expect(result).rejects.toBeInstanceOf(AppRoleError);
    await expect(result).rejects.toThrow(/the auth role must be subject to row level security/);
  });

  it('refuses a member of the owner role', async () => {
    const member = `auth_owner_member_${suffix}`;
    await owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await owner.query(`grant ${TEST_OWNER.user} to ${member}`);
    await expect(
      ensureAuthRole(tdb.ownerUrl, urlAs(tdb.authUrl, member, 'x'), tdb.appUrl),
    ).rejects.toThrow(/member of the owner role/);
  });

  it('refuses an auth role the application role can switch to', async () => {
    const linked = `auth_linked_${suffix}`;
    await owner.query(`create role ${linked} login password 'x' nosuperuser nobypassrls`);
    await owner.query(`grant ${linked} to ${TEST_APP.user}`);
    try {
      await expect(
        ensureAuthRole(tdb.ownerUrl, urlAs(tdb.authUrl, linked, 'x'), tdb.appUrl),
      ).rejects.toThrow(/members of each other/);
    } finally {
      await owner.query(`revoke ${linked} from ${TEST_APP.user}`);
    }
  });
});

describe('checkAuthRoleSeparation', () => {
  it('passes for the migrated application and auth roles', async () => {
    await expect(
      checkAuthRoleSeparation(SYSTEM, open(tdb.appUrl), open(tdb.authUrl)),
    ).resolves.toEqual({ separated: true, reasons: [] });
  });

  it('fails when the application role can read the session or account tables', async () => {
    await withAppGrant(
      `grant select on auth_session, auth_account to ${TEST_APP.user}`,
      `revoke select on auth_session, auth_account from ${TEST_APP.user}`,
      async () => {
        const result = await checkAuthRoleSeparation(SYSTEM, open(tdb.appUrl), open(tdb.authUrl));
        expect(result.separated).toBe(false);
        expect(result.reasons).toEqual(
          expect.arrayContaining([
            'application role can access auth_account',
            'application role can access auth_session',
          ]),
        );
      },
    );
  });

  it('fails when the application role can read or write more of auth_user', async () => {
    await withAppGrant(
      `grant select (is_instance_admin), update (is_instance_admin) on auth_user to ${TEST_APP.user}`,
      `revoke select (is_instance_admin), update (is_instance_admin) on auth_user from ${TEST_APP.user}`,
      async () => {
        const result = await checkAuthRoleSeparation(SYSTEM, open(tdb.appUrl), open(tdb.authUrl));
        expect(result.reasons).toEqual([
          'application role can write auth_user columns',
          'application role can read auth_user.is_instance_admin',
        ]);
      },
    );
  });

  it('fails when the auth connection is the application role', async () => {
    const result = await checkAuthRoleSeparation(SYSTEM, open(tdb.appUrl), open(tdb.appUrl));
    expect(result.separated).toBe(false);
    expect(result.reasons).toContain(
      `the auth connection uses the application role ${TEST_APP.user}`,
    );
    expect(result.reasons).toContain(
      'auth role lacks SELECT, INSERT, UPDATE or DELETE on auth_session',
    );
  });

  it('fails when the auth connection can bypass row level security or owns the tables', async () => {
    const result = await checkAuthRoleSeparation(SYSTEM, open(tdb.appUrl), open(tdb.ownerUrl));
    expect(result.reasons).toEqual(
      expect.arrayContaining(['auth role is SUPERUSER', 'auth role owns the tables']),
    );
  });
});
