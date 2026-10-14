import { randomUUID } from 'node:crypto';
import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RawTenant, seedRawTenant } from './__test__/raw-seed.js';
import { migrateAll } from './migrate-all.js';

let tdb: TestDatabase;
let owner: pg.Pool;
let app: pg.Pool;
let a: RawTenant;
let b: RawTenant;

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
  app = new pg.Pool({ connectionString: tdb.appUrl, max: 2 });
  a = await seedRawTenant(owner, 'alpha');
  b = await seedRawTenant(owner, 'bravo');
  await owner.query(
    "update apps set visibility = 'public', approval_status = 'approved' where id = $1",
    [b.appId],
  );
  await owner.query(
    "insert into audit_log (id, workspace_id, action, target_type, target_id) values ($1, null, 'keys.legacy_secrets_upgraded', 'keys', 'connections')",
    [randomUUID()],
  );
}, 120_000);

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await tdb?.stop();
});

type Mode = { tenant: string } | { system: true } | { none: true };

async function asApp<T extends pg.QueryResultRow>(
  mode: Mode,
  text: string,
  values: unknown[] = [],
) {
  const client = await app.connect();
  try {
    await client.query('begin');
    if ('tenant' in mode)
      await client.query("select set_config('owlwire.workspace_id', $1, true)", [mode.tenant]);
    if ('system' in mode) await client.query("select set_config('owlwire.system', 'on', true)");
    const result = await client.query<T>(text, values);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

describe('app connection', () => {
  it('runs as a role that is subject to row level security', async () => {
    const { rows } = await app.query<{
      me: string;
      owner: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      `select current_user as me, c.relowner::regrole::text as owner, r.rolsuper, r.rolbypassrls
       from pg_class c, pg_roles r where c.oid = 'public.audiences'::regclass and r.rolname = current_user`,
    );
    const row = rows[0];
    expect(row?.me).not.toBe(row?.owner);
    expect(row).toMatchObject({ rolsuper: false, rolbypassrls: false });
  });
});

const TENANT_TABLES = [
  'connections',
  'destinations',
  'installations',
  'rules',
  'rule_targets',
  'events',
  'deliveries',
  'workspace_keys',
  'audiences',
  'audience_members',
  'digests',
  'connection_counters',
  'audit_log',
] as const;

/** Privileges the app role does not hold at all (roles.ts grantAppAccess). */
const NO_UPDATE: ReadonlySet<string> = new Set(['audit_log']);
const NO_DELETE: ReadonlySet<string> = new Set(['audit_log', 'workspace_keys']);

describe.each(TENANT_TABLES)('%s', (table) => {
  it('tenant A sees only its own rows', async () => {
    const { rows } = await asApp<{ ws: string }>(
      { tenant: a.workspaceId },
      `select distinct workspace_id::text as ws from ${table}`,
    );
    expect(rows.map((r) => r.ws)).toEqual([a.workspaceId]);
  });

  it('no workspace setting means no rows', async () => {
    const { rows } = await asApp<{ n: number }>(
      { none: true },
      `select count(*)::int as n from ${table}`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('tenant A cannot update or delete B rows', async () => {
    // Each statement starts only when it is awaited: starting both up front lets a rejected delete go
    // unobserved while the update is still pending, which Node reports as an unhandled rejection.
    const update = () =>
      asApp(
        { tenant: a.workspaceId },
        `update ${table} set workspace_id = workspace_id where workspace_id = $1`,
        [b.workspaceId],
      );
    const remove = () =>
      asApp({ tenant: a.workspaceId }, `delete from ${table} where workspace_id = $1`, [
        b.workspaceId,
      ]);
    // audit_log is append-only and workspace_keys rows are never deleted by the app role.
    if (NO_UPDATE.has(table)) await expect(update()).rejects.toMatchObject({ code: '42501' });
    else expect((await update()).rowCount).toBe(0);
    if (NO_DELETE.has(table)) await expect(remove()).rejects.toMatchObject({ code: '42501' });
    else expect((await remove()).rowCount).toBe(0);
  });

  it('system mode sees both tenants', async () => {
    const { rows } = await asApp<{ n: number }>(
      { system: true },
      `select count(distinct workspace_id)::int as n from ${table} where workspace_id = any($1::uuid[])`,
      [[a.workspaceId, b.workspaceId]],
    );
    expect(rows[0]?.n).toBe(2);
  });
});

describe('writes', () => {
  it('rejects inserting a row for another workspace', async () => {
    await expect(
      asApp(
        { tenant: a.workspaceId },
        'insert into audiences (id, workspace_id, name) values ($1, $2, $3)',
        [randomUUID(), b.workspaceId, 'sneaky'],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('rejects moving an own row to another workspace', async () => {
    await expect(
      asApp({ tenant: a.workspaceId }, 'update audiences set workspace_id = $1 where id = $2', [
        b.workspaceId,
        a.audienceId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('allows inserting a row for the own workspace', async () => {
    const res = await asApp(
      { tenant: a.workspaceId },
      'insert into audiences (id, workspace_id, name) values ($1, $2, $3)',
      [randomUUID(), a.workspaceId, 'own'],
    );
    expect(res.rowCount).toBe(1);
  });
});

describe('workspaces', () => {
  it('tenant sees only its own workspace', async () => {
    const { rows } = await asApp<{ id: string }>(
      { tenant: a.workspaceId },
      'select id::text from workspaces',
    );
    expect(rows.map((r) => r.id)).toEqual([a.workspaceId]);
  });

  it('tenant can create a workspace only with its own id', async () => {
    const id = randomUUID();
    await expect(
      asApp(
        { tenant: a.workspaceId },
        "insert into workspaces (id, name, slug, kind) values ($1, 'x', $2, 'community')",
        [id, `x-${id}`],
      ),
    ).rejects.toMatchObject({ code: '42501' });
    const ok = await asApp(
      { tenant: id },
      "insert into workspaces (id, name, slug, kind) values ($1, 'x', $2, 'community')",
      [id, `x-${id}`],
    );
    expect(ok.rowCount).toBe(1);
  });
});

describe('apps and catalog_types', () => {
  it('tenant sees own private apps and approved public apps of others', async () => {
    const { rows } = await asApp<{ id: string }>(
      { tenant: a.workspaceId },
      'select id::text from apps order by 1',
    );
    expect(rows.map((r) => r.id).sort()).toEqual([a.appId, b.appId].sort());
  });

  it('tenant does not see private apps of others', async () => {
    const { rows } = await asApp<{ id: string }>(
      { tenant: b.workspaceId },
      'select id::text from apps',
    );
    expect(rows.map((r) => r.id)).not.toContain(a.appId);
  });

  it('pending public apps of others are invisible', async () => {
    await owner.query("update apps set approval_status = 'pending' where id = $1", [b.appId]);
    try {
      const { rows } = await asApp<{ id: string }>(
        { tenant: a.workspaceId },
        'select id::text from apps',
      );
      expect(rows.map((r) => r.id)).not.toContain(b.appId);
    } finally {
      await owner.query("update apps set approval_status = 'approved' where id = $1", [b.appId]);
    }
  });

  it('tenant cannot modify another workspace public app', async () => {
    const res = await asApp(
      { tenant: a.workspaceId },
      "update apps set name = 'hijacked' where id = $1",
      [b.appId],
    );
    expect(res.rowCount).toBe(0);
  });

  it('tenant reads catalog of a visible public app but cannot write it', async () => {
    const { rows } = await asApp<{ key: string }>(
      { tenant: a.workspaceId },
      'select key from catalog_types where app_id = $1',
      [b.appId],
    );
    expect(rows.map((r) => r.key)).toEqual(['generic']);
    await expect(
      asApp(
        { tenant: a.workspaceId },
        "insert into catalog_types (app_id, key, name) values ($1, 'evil', 'Evil')",
        [b.appId],
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('tenant does not see catalog of an invisible private app', async () => {
    const { rows } = await asApp<{ n: number }>(
      { tenant: b.workspaceId },
      'select count(*)::int as n from catalog_types where app_id = $1',
      [a.appId],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('audit_log instance entries', () => {
  it('are invisible to tenants and visible to system', async () => {
    const tenant = await asApp<{ n: number }>(
      { tenant: a.workspaceId },
      'select count(*)::int as n from audit_log where workspace_id is null',
    );
    expect(tenant.rows[0]?.n).toBe(0);
    const system = await asApp<{ n: number }>(
      { system: true },
      'select count(*)::int as n from audit_log where workspace_id is null',
    );
    expect(system.rows[0]?.n).toBe(1);
  });
});
