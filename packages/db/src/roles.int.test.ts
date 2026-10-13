import { randomBytes } from 'node:crypto';
import { startTestDatabase, TEST_APP, type TestDatabase } from '@owlwire/testing';
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
    expect(rows[0]?.owner).not.toBe(TEST_APP.user);
  });

  it('cannot create tables in public', async () => {
    await expect(app.query('create table app_should_not_create (id int)')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('can read and write application tables', async () => {
    await expect(app.query('select count(*) from workspaces')).resolves.toBeDefined();
  });

  it('can enqueue graphile worker jobs', async () => {
    await expect(
      app.query(`select graphile_worker.add_job('noop_test', '{}'::json)`),
    ).resolves.toBeDefined();
  });

  it('is idempotent and serialised by the advisory lock when migrateAll runs concurrently', async () => {
    const opts = { ownerUrl: tdb.ownerUrl, appUrl: tdb.appUrl };
    await expect(Promise.all([migrateAll(opts), migrateAll(opts)])).resolves.toEqual([
      { appRole: 'separate' },
      { appRole: 'separate' },
    ]);
  });

  it('returns "same" when app and owner are the same user', async () => {
    await expect(ensureAppRole(tdb.ownerUrl, tdb.ownerUrl)).resolves.toBe('same');
  });

  it('refuses an existing superuser or BYPASSRLS role as app role', async () => {
    const evil = `evil_app_${suffix}`;
    await owner.query(`create role ${evil} login password 'x' bypassrls`);
    await expect(ensureAppRole(tdb.ownerUrl, urlAs(tdb.appUrl, evil, 'x'))).rejects.toBeInstanceOf(
      AppRoleError,
    );
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
    ).rejects.toBeInstanceOf(AppRoleError);
  });
});
