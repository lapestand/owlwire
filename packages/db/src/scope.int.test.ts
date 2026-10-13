import { FakeClock } from '@owlwire/core';
import { createKeyring, generateKek } from '@owlwire/crypto';
import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RawTenant, seedRawTenant } from './__test__/raw-seed.js';
import { dbInternals, type OwlwireDb, openDatabase } from './handle.js';
import { migrateAll } from './migrate-all.js';
import {
  InvalidScopeError,
  SYSTEM,
  tenantScope,
  txInternals,
  withSystem,
  withTenant,
} from './scope.js';

const WS_A = '0192f0a0-0000-7000-8000-00000000000a';
const WS_B = '0192f0a0-0000-7000-8000-00000000000b';

let tdb: TestDatabase;
let single: OwlwireDb; // tek bağlantılı havuz: sızıntıyı görünür kılar
let multi: OwlwireDb;
let owner: pg.Pool;
let seededA: RawTenant;
let seededB: RawTenant;

const settingsOn = async (db: OwlwireDb) => {
  const res = await dbInternals(db).drizzle.execute(
    sql`select coalesce(current_setting('owlwire.workspace_id', true), '') as ws, coalesce(current_setting('owlwire.system', true), '') as sys`,
  );
  return res.rows[0] as { ws: string; sys: string };
};

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  const opts = {
    url: tdb.appUrl,
    keyring: createKeyring(generateKek(1)),
    clock: new FakeClock(new Date('2026-10-12T09:00:00Z')),
  };
  single = openDatabase({ ...opts, maxConnections: 1 });
  multi = openDatabase({ ...opts, maxConnections: 3 });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl, max: 1 });
  seededA = await seedRawTenant(owner, 'alpha');
  seededB = await seedRawTenant(owner, 'bravo');
}, 120_000);

afterAll(async () => {
  await single?.close();
  await multi?.close();
  await owner?.end();
  await tdb?.stop();
});

describe('tenantScope', () => {
  it.each([
    '',
    'not-a-uuid',
    "0192f0a0-0000-7000-8000-00000000000a'; drop table workspaces; --",
    '{}',
  ])('rejects %j', (v) => {
    expect(() => tenantScope(v)).toThrow(InvalidScopeError);
  });

  it('normalizes to lower case', () => {
    expect(tenantScope(WS_A.toUpperCase()).workspaceId).toBe(WS_A);
  });
});

describe('withTenant', () => {
  it('sets the workspace setting inside the transaction only', async () => {
    const inside = await withTenant(single, tenantScope(WS_A), async (t) => {
      const res = await txInternals(t).tx.execute(
        sql`select current_setting('owlwire.workspace_id', true) as ws`,
      );
      return (res.rows[0] as { ws: string }).ws;
    });
    expect(inside).toBe(WS_A);
    expect(await settingsOn(single)).toEqual({ ws: '', sys: '' });
  });

  it('does not leak the setting after a rollback', async () => {
    await expect(
      withTenant(single, tenantScope(WS_A), async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await settingsOn(single)).toEqual({ ws: '', sys: '' });
  });

  it('validates scope objects that were not built with tenantScope', async () => {
    await expect(withTenant(single, { workspaceId: 'nope' }, async () => 1)).rejects.toBeInstanceOf(
      InvalidScopeError,
    );
  });

  it('keeps parallel transactions on a shared pool isolated', async () => {
    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) => {
        const ws = i % 2 === 0 ? WS_A : WS_B;
        return withTenant(multi, tenantScope(ws), async (t) => {
          await txInternals(t).tx.execute(sql`select pg_sleep(0.01)`);
          const res = await txInternals(t).tx.execute(
            sql`select current_setting('owlwire.workspace_id', true) as ws`,
          );
          return { expected: ws, actual: (res.rows[0] as { ws: string }).ws };
        });
      }),
    );
    for (const r of results) expect(r.actual).toBe(r.expected);
  });

  it('exposes the scope workspace id on the TenantTx', async () => {
    await withTenant(single, tenantScope(WS_B), async (t) => {
      expect(t.workspaceId).toBe(WS_B);
    });
  });
});

describe('withSystem', () => {
  it('sets system mode and clears workspace, without leaking', async () => {
    const inside = await withSystem(single, SYSTEM, async (s) => {
      const res = await txInternals(s).tx.execute(
        sql`select current_setting('owlwire.system', true) as sys, current_setting('owlwire.workspace_id', true) as ws`,
      );
      return res.rows[0] as { sys: string; ws: string };
    });
    expect(inside).toEqual({ sys: 'on', ws: '' });
    expect(await settingsOn(single)).toEqual({ ws: '', sys: '' });
  });

  it('a tenant transaction after a system transaction is not in system mode', async () => {
    await withSystem(single, SYSTEM, async () => undefined);
    const sys = await withTenant(single, tenantScope(WS_A), async (t) => {
      const res = await txInternals(t).tx.execute(
        sql`select coalesce(current_setting('owlwire.system', true), '') as sys`,
      );
      return (res.rows[0] as { sys: string }).sys;
    });
    expect(sys).toBe('');
  });
});

describe('setting isolation on one pooled connection', () => {
  const backendPid = async (db: OwlwireDb) => {
    const res = await dbInternals(db).drizzle.execute(sql`select pg_backend_pid() as pid`);
    return (res.rows[0] as { pid: number }).pid;
  };

  it('reuses one backend, so the leak checks are meaningful', async () => {
    const before = await backendPid(single);
    await withTenant(single, tenantScope(WS_A), async () => undefined);
    await withSystem(single, SYSTEM, async () => undefined);
    expect(await backendPid(single)).toBe(before);
  });

  it('a tenant transaction after another tenant on the same connection sees only its own workspace', async () => {
    await withTenant(single, tenantScope(WS_A), async () => undefined);
    expect(await settingsOn(single)).toEqual({ ws: '', sys: '' });
    const seen = await withTenant(single, tenantScope(WS_B), async (t) => {
      const res = await txInternals(t).tx.execute(
        sql`select current_setting('owlwire.workspace_id', true) as ws, coalesce(current_setting('owlwire.system', true), '') as sys`,
      );
      return res.rows[0] as { ws: string; sys: string };
    });
    expect(seen).toEqual({ ws: WS_B, sys: '' });
  });

  it('system mode is off on the connection after withSystem, also after a rollback', async () => {
    await withSystem(single, SYSTEM, async () => undefined);
    expect(await settingsOn(single)).toEqual({ ws: '', sys: '' });
    await expect(
      withSystem(single, SYSTEM, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await settingsOn(single)).toEqual({ ws: '', sys: '' });
  });
});

describe('row level security through the app role', () => {
  const visibleWorkspaces = async (rows: Promise<{ rows: unknown[] }>) =>
    (await rows).rows.map((r) => (r as { id: string }).id).sort();

  it('runs as the non bypassing app role', async () => {
    const res = await dbInternals(single).drizzle.execute(
      sql`select current_user as role, r.rolsuper as super, r.rolbypassrls as bypass from pg_roles r where r.rolname = current_user`,
    );
    expect(res.rows[0]).toMatchObject({ super: false, bypass: false });
    expect((res.rows[0] as { role: string }).role).not.toBe('owlwire');
  });

  it('withTenant sees only its own workspace rows', async () => {
    const ids = await withTenant(single, tenantScope(seededA.workspaceId), (t) =>
      visibleWorkspaces(txInternals(t).tx.execute(sql`select id from workspaces`)),
    );
    expect(ids).toEqual([seededA.workspaceId]);
  });

  it('withSystem sees every workspace and no scope sees none', async () => {
    const ids = await withSystem(single, SYSTEM, (s) =>
      visibleWorkspaces(txInternals(s).tx.execute(sql`select id from workspaces`)),
    );
    expect(ids).toEqual(expect.arrayContaining([seededA.workspaceId, seededB.workspaceId]));
    expect(
      await visibleWorkspaces(dbInternals(single).drizzle.execute(sql`select id from workspaces`)),
    ).toEqual([]);
  });
});
