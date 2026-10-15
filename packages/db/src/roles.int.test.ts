import { randomBytes, randomUUID } from 'node:crypto';
import { startTestDatabase, TEST_APP, TEST_OWNER, type TestDatabase } from '@owlwire/testing';
import { Logger as GraphileLogger, run } from 'graphile-worker';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateAll } from './migrate-all.js';
import { AppRoleError, ensureAppRole } from './roles.js';

let tdb: TestDatabase;
let app: pg.Pool;
let owner: pg.Pool;
const suffix = randomBytes(4).toString('hex');

const urlAs = (base: string, user: string, password: string) => {
  const u = new URL(base);
  u.username = user;
  u.password = password;
  return u.toString();
};

async function expectAppRoleError(result: Promise<unknown>, message: RegExp): Promise<void> {
  await expect(result).rejects.toBeInstanceOf(AppRoleError);
  await expect(result).rejects.toThrow(message);
}

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  app = new pg.Pool({ connectionString: tdb.appUrl });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
}, 120_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

describe('app role', () => {
  it('connects as a non-superuser without BYPASSRLS', async () => {
    const { rows } = await app.query<{ user: string; rolsuper: boolean; rolbypassrls: boolean }>(
      'select current_user as user, r.rolsuper, r.rolbypassrls from pg_roles r where r.rolname = current_user',
    );
    expect(rows[0]).toEqual({ user: TEST_APP.user, rolsuper: false, rolbypassrls: false });
  });

  it('does not own application tables', async () => {
    const { rows } = await app.query<{ owner: string }>(
      "select tableowner as owner from pg_tables where schemaname = 'public' and tablename = 'workspaces'",
    );
    expect(rows[0]?.owner).toBe(TEST_OWNER.user);
  });

  it('cannot create tables in public', async () => {
    await expect(app.query('create table app_should_not_create (id int)')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('can read and write application tables', async () => {
    const client = await app.connect();
    try {
      await client.query('begin');
      // RLS: uygulama rolü yalnız transaction'da seçili workspace'in satırlarına erişir.
      const id = randomUUID();
      await client.query("select set_config('owlwire.workspace_id', $1, true)", [id]);
      const inserted = await client.query(
        "insert into workspaces (id, name, slug, kind) values ($1, 'w', $2, 'personal')",
        [id, `rw_${suffix}`],
      );
      expect(inserted.rowCount).toBe(1);
      const updated = await client.query("update workspaces set name = 'w2' where id = $1", [id]);
      expect(updated.rowCount).toBe(1);
      const read = await client.query<{ name: string }>(
        'select name from workspaces where id = $1',
        [id],
      );
      expect(read.rows[0]?.name).toBe('w2');
      const deleted = await client.query('delete from workspaces where id = $1', [id]);
      expect(deleted.rowCount).toBe(1);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('can only append to audit_log, cannot delete workspace_keys, and can still update them', async () => {
    for (const statement of [
      'update audit_log set action = action',
      'delete from audit_log',
      'truncate audit_log',
      'delete from workspace_keys',
      'truncate workspace_keys',
    ]) {
      await expect(app.query(statement), statement).rejects.toMatchObject({ code: '42501' });
    }
    // Rotation re-wraps keys with UPDATE ... FOR UPDATE; RLS hides every row without a workspace setting.
    await expect(app.query('select 1 from workspace_keys for update')).resolves.toMatchObject({
      rowCount: 0,
    });
    await expect(
      app.query('update workspace_keys set kek_version = kek_version'),
    ).resolves.toMatchObject({ rowCount: 0 });
  });

  it('still inserts audit rows and keys, and deleting a workspace cascades to them', async () => {
    const client = await app.connect();
    try {
      await client.query('begin');
      const id = randomUUID();
      await client.query("select set_config('owlwire.workspace_id', $1, true)", [id]);
      await client.query(
        "insert into workspaces (id, name, slug, kind) values ($1, 'w', $2, 'personal')",
        [id, `cascade_${suffix}`],
      );
      await client.query(
        "insert into workspace_keys (workspace_id, wrapped_dek, kek_version) values ($1, '\\x00', 1)",
        [id],
      );
      await client.query(
        "insert into audit_log (id, workspace_id, action, target_type, target_id) values ($1, $2, 'workspace.created', 'workspace', $3)",
        [randomUUID(), id, id],
      );
      // FK actions run as the table owner, so the revoked privileges do not block the cascade.
      const deleted = await client.query('delete from workspaces where id = $1', [id]);
      expect(deleted.rowCount).toBe(1);
      const left = await client.query<{ n: number }>(
        'select (select count(*) from workspace_keys where workspace_id = $1) + (select count(*) from audit_log where workspace_id = $1) as n',
        [id],
      );
      expect(Number(left.rows[0]?.n)).toBe(0);
    } finally {
      await client.query('rollback');
      client.release();
    }
  });

  it('can enqueue graphile worker jobs', async () => {
    await expect(
      app.query(`select graphile_worker.add_job('noop_test', '{}'::json)`),
    ).resolves.toBeDefined();
  });

  it('cannot modify graphile worker migration bookkeeping', async () => {
    await expect(app.query('delete from graphile_worker.migrations')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      app.query('insert into graphile_worker.migrations (id) values (999999)'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      app.query(`select graphile_worker.add_job('noop_test_after_revoke', '{}'::json)`),
    ).resolves.toBeDefined();
  });

  it('can start graphile worker at runtime (its migration check reads the bookkeeping)', async () => {
    const pool = new pg.Pool({ connectionString: tdb.appUrl, max: 2 });
    pool.on('error', () => undefined);
    pool.on('connect', (client) => client.on('error', () => undefined));
    try {
      const runner = await run({
        pgPool: pool,
        taskList: { noop_runtime_test: async () => undefined },
        noHandleSignals: true,
        pollInterval: 60_000,
        logger: new GraphileLogger(() => () => undefined),
      });
      await runner.stop();
    } finally {
      await pool.end();
    }
  });

  it('is idempotent and serialised by the advisory lock when migrateAll runs concurrently', async () => {
    const opts = { ownerUrl: tdb.ownerUrl, appUrl: tdb.appUrl, authUrl: tdb.authUrl };
    await expect(Promise.all([migrateAll(opts), migrateAll(opts)])).resolves.toEqual([
      { appRole: 'separate', authRole: 'separate' },
      { appRole: 'separate', authRole: 'separate' },
    ]);
  });

  it('returns "same" when app and owner are the same user', async () => {
    await expect(ensureAppRole(tdb.ownerUrl, tdb.ownerUrl)).resolves.toBe('same');
  });

  it('refuses an existing BYPASSRLS role as app role', async () => {
    const evil = `evil_app_${suffix}`;
    await owner.query(`create role ${evil} login password 'x' bypassrls`);
    await expectAppRoleError(
      ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, evil, 'x')),
      /is SUPERUSER or BYPASSRLS;/,
    );
  });

  it('refuses an existing superuser role as app role', async () => {
    const su = `su_app_${suffix}`;
    await owner.query(`create role ${su} login password 'x' superuser`);
    await expectAppRoleError(
      ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, su, 'x')),
      /is SUPERUSER or BYPASSRLS;/,
    );
  });

  it('refuses an app role that is a member of the owner role', async () => {
    const member = `owner_member_${suffix}`;
    await owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await owner.query(`grant ${TEST_OWNER.user} to ${member}`);
    await expectAppRoleError(
      ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, member, 'x')),
      /member of the owner role/,
    );
  });

  it('refuses an app role that is a member of a BYPASSRLS role', async () => {
    const bypass = `bypass_grp_${suffix}`;
    const member = `bypass_member_${suffix}`;
    await owner.query(`create role ${bypass} nologin bypassrls`);
    await owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await owner.query(`grant ${bypass} to ${member}`);
    await expectAppRoleError(
      ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, member, 'x')),
      /member of a SUPERUSER or BYPASSRLS role/,
    );
  });

  it('refuses an app role that is a member of a non-owner superuser role', async () => {
    const su = `su_grp_${suffix}`;
    const member = `su_member_${suffix}`;
    await owner.query(`create role ${su} nologin superuser`);
    await owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await owner.query(`grant ${su} to ${member}`);
    await expectAppRoleError(
      ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, member, 'x')),
      /member of a SUPERUSER or BYPASSRLS role/,
    );
  });

  it('refuses an app role that owns an application relation', async () => {
    const tableOwner = `table_owner_${suffix}`;
    const table = `owned_by_app_${suffix}`;
    await owner.query(`create role ${tableOwner} login password 'x' nosuperuser nobypassrls`);
    await owner.query(`create table public.${table} (id int)`);
    await owner.query(`alter table public.${table} owner to ${tableOwner}`);
    try {
      await expectAppRoleError(
        ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, tableOwner, 'x')),
        /owns relations/,
      );
    } finally {
      await owner.query(`drop table public.${table}`);
    }
  });

  it('refuses an app role that inherits a role owning an application relation', async () => {
    const group = `rel_owner_grp_${suffix}`;
    const member = `rel_owner_member_${suffix}`;
    const table = `owned_by_grp_${suffix}`;
    await owner.query(`create role ${group} nologin nosuperuser nobypassrls`);
    await owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await owner.query(`grant ${group} to ${member}`);
    await owner.query(`create table public.${table} (id int)`);
    await owner.query(`alter table public.${table} owner to ${group}`);
    try {
      await expectAppRoleError(
        ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, member, 'x')),
        /owns relations/,
      );
    } finally {
      await owner.query(`drop table public.${table}`);
    }
  });

  it('refuses an app role that owns an application schema through membership', async () => {
    const group = `schema_owner_grp_${suffix}`;
    const member = `schema_owner_member_${suffix}`;
    await owner.query(`create role ${group} nologin nosuperuser nobypassrls`);
    await owner.query(`create role ${member} login password 'x' nosuperuser nobypassrls`);
    await owner.query(`grant ${group} to ${member}`);
    const existing = await owner.query<{ owner: string }>(
      "select nspowner::regrole::text as owner from pg_namespace where nspname = 'owlwire_private'",
    );
    const previousOwner = existing.rows[0]?.owner;
    if (previousOwner) await owner.query(`alter schema owlwire_private owner to ${group}`);
    else await owner.query(`create schema owlwire_private authorization ${group}`);
    try {
      await expectAppRoleError(
        ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, member, 'x')),
        /owns schemas/,
      );
    } finally {
      if (previousOwner)
        await owner.query(`alter schema owlwire_private owner to ${previousOwner}`);
      else await owner.query('drop schema owlwire_private');
    }
  });

  it('leaves the password of an existing role untouched', async () => {
    const preset = `preset_app_${suffix}`;
    await owner.query(`create role ${preset} login password 'preset_pw'`);
    await expect(ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, preset, 'other_pw'))).resolves.toBe(
      'separate',
    );
    const client = new pg.Client({ connectionString: urlAs(tdb.appUrl, preset, 'preset_pw') });
    await client.connect();
    await expect(client.query('select count(*) from workspaces')).resolves.toBeDefined();
    await client.end();
  });

  it('requires a password to create a missing role', async () => {
    const noPw = new URL(tdb.appUrl);
    noPw.username = `ghost_app_${suffix}`;
    noPw.password = '';
    await expect(ensureAppRole(tdb.ownerUrl, noPw.toString())).rejects.toThrow('password');
  });

  it('fails with AppRoleError when the role is missing and the owner cannot create roles', async () => {
    const weak = `weak_owner_${suffix}`;
    await owner.query(`create role ${weak} login password 'w' nosuperuser nocreaterole`);
    await expect(
      ensureAppRole(
        urlAs(tdb.ownerUrl, weak, 'w'),
        urlAs(tdb.appUrl, `ghost2_app_${suffix}`, 'pw'),
      ),
    ).rejects.toThrow(/create it manually .* or grant CREATEROLE to the migration role$/);
  });
});
