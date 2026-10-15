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

/** Closes a handle before afterAll does, for example so the role it signed in as can be dropped. */
const closeNow = async (db: OwlwireDb): Promise<void> => {
  opened.splice(opened.indexOf(db), 1);
  await db.close();
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

/**
 * Creates a login role named `<prefix>_<suffix>` with password 'x', runs fn with it, and always drops it again.
 * Roles live in the cluster, not in the scratch database, so a role left behind would outlive the test run.
 */
async function withTestRole(
  prefix: string,
  attributes: string,
  fn: (role: string) => Promise<void>,
): Promise<void> {
  const role = `${prefix}_${suffix}`;
  await owner.query(`create role ${role} login password 'x' ${attributes}`);
  try {
    await fn(role);
  } finally {
    await owner.query(`drop role ${role}`);
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
    await withTestRole('evil_auth', 'bypassrls', async (evil) => {
      const result = ensureAuthRole(tdb.ownerUrl, urlAs(tdb.authUrl, evil, 'x'), tdb.appUrl);
      await expect(result).rejects.toBeInstanceOf(AppRoleError);
      await expect(result).rejects.toThrow(/the auth role must be subject to row level security/);
    });
  });

  it('refuses a member of the owner role', async () => {
    await withTestRole('auth_owner_member', 'nosuperuser nobypassrls', async (member) => {
      await owner.query(`grant ${TEST_OWNER.user} to ${member}`);
      await expect(
        ensureAuthRole(tdb.ownerUrl, urlAs(tdb.authUrl, member, 'x'), tdb.appUrl),
      ).rejects.toThrow(/member of the owner role/);
    });
  });

  it('refuses an auth role the application role can switch to', async () => {
    await withTestRole('auth_linked', 'nosuperuser nobypassrls', async (linked) => {
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

  // The shared test roles stay untouched: each case makes a fresh role that acts as one side (it inherits the
  // shared role's privileges) and links it to the other side. Membership without INHERIT grants no table privilege,
  // so only the membership check can see it, yet it still allows SET ROLE.
  it('fails when the application role can switch to the auth role', async () => {
    await withTestRole('app_into_auth', 'nosuperuser nobypassrls', async (role) => {
      await owner.query(`grant ${TEST_APP.user} to ${role}`);
      await owner.query(`grant ${TEST_AUTH.user} to ${role} with inherit false`);
      const appDb = open(urlAs(tdb.appUrl, role, 'x'));
      try {
        const result = await checkAuthRoleSeparation(SYSTEM, appDb, open(tdb.authUrl));
        expect(result).toEqual({
          separated: false,
          reasons: [`roles ${role} and ${TEST_AUTH.user} are members of each other`],
        });
      } finally {
        await closeNow(appDb);
      }
    });
  });

  it('fails when the auth role can switch to the application role', async () => {
    await withTestRole('auth_into_app', 'nosuperuser nobypassrls', async (role) => {
      await owner.query(`grant ${TEST_AUTH.user} to ${role}`);
      await owner.query(`grant ${TEST_APP.user} to ${role} with inherit false`);
      const authDb = open(urlAs(tdb.authUrl, role, 'x'));
      try {
        const result = await checkAuthRoleSeparation(SYSTEM, open(tdb.appUrl), authDb);
        expect(result).toEqual({
          separated: false,
          reasons: [`roles ${TEST_APP.user} and ${role} are members of each other`],
        });
      } finally {
        await closeNow(authDb);
      }
    });
  });

  it('fails when the auth connection can bypass row level security or owns the tables', async () => {
    const result = await checkAuthRoleSeparation(SYSTEM, open(tdb.appUrl), open(tdb.ownerUrl));
    expect(result.reasons).toEqual(
      expect.arrayContaining(['auth role is SUPERUSER', 'auth role owns the tables']),
    );
  });
});
