import { randomUUID } from 'node:crypto';
import { FakeClock } from '@owlwire/core';
import { createKeyring, generateKek } from '@owlwire/crypto';
import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type RawTenant, seedRawTenant } from './__test__/raw-seed.js';
import { mapPgErrors, pgErrorOf, safeErrorMessage } from './errors.js';
import { dbInternals, type OwlwireDb, openDatabase } from './handle.js';
import { migrateAll } from './migrate-all.js';
import { workspaces } from './schema/index.js';
import {
  InvalidScopeError,
  NestedScopeError,
  ScopeClosedError,
  SYSTEM,
  SystemTx,
  TenantTx,
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

describe('closed scopes', () => {
  // A repo-style query: every repository call goes through txInternals at query time.
  const listWorkspaceIds = async (t: TenantTx | SystemTx) =>
    (await txInternals(t).tx.select({ id: workspaces.id }).from(workspaces)).map((r) => r.id);

  it('a TenantTx leaked from withTenant(A) cannot run inside withTenant(B)', async () => {
    let leaked: TenantTx | undefined;
    await withTenant(single, tenantScope(seededA.workspaceId), async (t) => {
      leaked = t;
      expect(await listWorkspaceIds(t)).toEqual([seededA.workspaceId]);
    });
    if (!leaked) throw new Error('not captured');
    const stale = leaked;
    const own = await withTenant(single, tenantScope(seededB.workspaceId), async (t) => {
      await expect(listWorkspaceIds(stale)).rejects.toBeInstanceOf(ScopeClosedError);
      // The current transaction is untouched by the rejected call.
      return listWorkspaceIds(t);
    });
    expect(own).toEqual([seededB.workspaceId]);
    expect(() => txInternals(stale)).toThrow(ScopeClosedError);
  });

  it('a SystemTx leaked from withSystem cannot run inside withTenant(B)', async () => {
    let leaked: SystemTx | undefined;
    await withSystem(single, SYSTEM, async (s) => {
      leaked = s;
    });
    if (!leaked) throw new Error('not captured');
    const stale = leaked;
    await withTenant(single, tenantScope(seededB.workspaceId), async () => {
      await expect(listWorkspaceIds(stale)).rejects.toBeInstanceOf(ScopeClosedError);
    });
  });

  it('the Tx is closed after a rollback too', async () => {
    let leaked: TenantTx | undefined;
    await expect(
      withTenant(single, tenantScope(WS_A), async (t) => {
        leaked = t;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    if (!leaked) throw new Error('not captured');
    expect(() => txInternals(leaked as TenantTx)).toThrow(ScopeClosedError);
  });

  it('TenantTx and SystemTx cannot be constructed outside the scope functions', () => {
    const forge = Symbol('owlwire.scoped-tx');
    const T = TenantTx as unknown as new (...args: unknown[]) => TenantTx;
    const S = SystemTx as unknown as new (...args: unknown[]) => SystemTx;
    expect(() => new T(forge, WS_A, {})).toThrow(TypeError);
    expect(() => new S(forge, {})).toThrow(TypeError);
    expect(() => txInternals({ workspaceId: WS_A } as unknown as TenantTx)).toThrow(TypeError);
  });
});

describe('nested scopes', () => {
  const NO_HANG_MS = 3_000; // below the 5 s pool connection timeout

  it.each([
    ['withTenant', 'withTenant'],
    ['withTenant', 'withSystem'],
    ['withSystem', 'withTenant'],
    ['withSystem', 'withSystem'],
  ] as const)(
    '%s inside %s throws NestedScopeError on a one connection pool',
    async (inner, outer) => {
      const run = <T>(kind: 'withTenant' | 'withSystem', fn: () => Promise<T>): Promise<T> =>
        kind === 'withTenant'
          ? withTenant(single, tenantScope(WS_A), fn)
          : withSystem(single, SYSTEM, fn);
      const result = await run(outer, async () => {
        const err = await run(inner, async () => 'inner ran').catch((e: unknown) => e);
        return { err, after: 'outer continues' };
      });
      expect(result.err).toBeInstanceOf(NestedScopeError);
      expect(result.after).toBe('outer continues');
    },
    NO_HANG_MS,
  );

  it('a scope started from work that outlives its callback is not treated as nested', async () => {
    let later: Promise<string> | undefined;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    await withTenant(single, tenantScope(WS_A), async () => {
      later = gate.then(() => withTenant(single, tenantScope(WS_B), async (t) => t.workspaceId));
    });
    release();
    expect(await later).toBe(WS_B);
  });
});

describe('connection lifecycle', () => {
  const openOne = () =>
    openDatabase({
      url: tdb.appUrl,
      keyring: createKeyring(generateKek(1)),
      clock: new FakeClock(new Date(0)),
      maxConnections: 1,
    });
  const pidIn = (db: OwlwireDb) =>
    withTenant(db, tenantScope(WS_A), async (t) => {
      const res = await txInternals(t).tx.execute(sql`select pg_backend_pid() as pid`);
      return (res.rows[0] as { pid: number }).pid;
    });
  const watchReleases = (db: OwlwireDb) => {
    const released: (Error | undefined)[] = [];
    dbInternals(db).pool.on('release', (err: Error | undefined) => released.push(err));
    return released;
  };

  it('a failed BEGIN gives the pool slot back, destroys the client and leaves no nested marker', async () => {
    const one = openOne();
    // The pool's only client goes back idle inside an aborted transaction, so the scope's BEGIN
    // fails (25P02) before fn can run. Queries are awaited one by one: queuing them on a client
    // that is already executing triggers pg's DeprecationWarning.
    const poisoned = await dbInternals(one).pool.connect();
    await poisoned.query('begin');
    await poisoned.query('select 1/0').catch(() => undefined);
    poisoned.release();
    const released = watchReleases(one);
    let continuation: Promise<unknown> | undefined;
    // 'acquire' fires inside the scope's async context, so the timer inherits the scope marker.
    dbInternals(one).pool.once('acquire', () => {
      continuation = new Promise((resolve) => setTimeout(resolve, 50)).then(() =>
        withTenant(single, tenantScope(WS_B), async (t) => t.workspaceId).catch((e: unknown) => e),
      );
    });
    const failed = await withTenant(one, tenantScope(WS_A), async () => 'never').catch(
      (e: unknown) => e,
    );
    expect(pgErrorOf(failed)?.code).toBe('25P02');
    expect(await continuation).toBe(WS_B);
    expect(released).toHaveLength(1);
    expect(released[0]).toBeInstanceOf(Error);
    // max 1: this only works if the slot came back.
    expect(await withTenant(one, tenantScope(WS_B), async (t) => t.workspaceId)).toBe(WS_B);
    await expect(one.close()).resolves.toBeUndefined();
  });

  it('a body error with a clean rollback returns the same client to the pool', async () => {
    const one = openOne();
    const released = watchReleases(one);
    const before = await pidIn(one);
    await expect(
      withTenant(one, tenantScope(WS_A), async (t) => {
        await txInternals(t).tx.execute(sql`select 1/0`);
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(await pidIn(one)).toBe(before);
    expect(released).toEqual([undefined, undefined, undefined]);
    await one.close();
  });

  it('a failed COMMIT destroys the client and frees the slot', async () => {
    const one = openOne();
    const released = watchReleases(one);
    const before = await pidIn(one);
    const failed = await withTenant(one, tenantScope(WS_A), async (t) => {
      const { tx } = txInternals(t);
      await tx.execute(
        sql`create temp table commit_probe (x int unique deferrable initially deferred) on commit drop`,
      );
      await tx.execute(sql`insert into commit_probe values (1), (1)`);
      return 'body done';
    }).catch((e: unknown) => e);
    expect(pgErrorOf(failed)?.code).toBe('23505');
    expect(released.at(-1)).toBeInstanceOf(Error);
    expect(await pidIn(one)).not.toBe(before);
    await expect(one.close()).resolves.toBeUndefined();
  });
});

describe('errors from a real database', () => {
  it('safeErrorMessage names a DrizzleQueryError and drops its params; 42501 is rethrown unchanged', async () => {
    const secret = `secret-slug-${randomUUID()}`;
    const id = randomUUID();
    const err = await withTenant(single, tenantScope(seededA.workspaceId), (t) =>
      txInternals(t)
        .tx.insert(workspaces)
        .values({ id, name: 'x', slug: secret, kind: 'community' }),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(secret); // the raw message does carry params
    const safe = safeErrorMessage(err);
    expect(safe.startsWith('DrizzleQueryError: Failed query: insert into "workspaces"')).toBe(true);
    expect(safe).not.toContain('params:');
    expect(safe).not.toContain(secret);
    expect(pgErrorOf(err)?.code).toBe('42501');
    await expect(mapPgErrors('workspace', id, () => Promise.reject(err))).rejects.toBe(err);
  });
});

describe('pool errors', () => {
  it('an idle client killed by the server reaches onPoolError exactly once', async () => {
    const seen: Error[] = [];
    const db = openDatabase({
      url: tdb.appUrl,
      keyring: createKeyring(generateKek(1)),
      clock: new FakeClock(new Date(0)),
      maxConnections: 1,
      onPoolError: (err) => seen.push(err),
    });
    try {
      const res = await dbInternals(db).drizzle.execute(sql`select pg_backend_pid() as pid`);
      const pid = (res.rows[0] as { pid: number }).pid;
      await owner.query('select pg_terminate_backend($1)', [pid]);
      for (let i = 0; i < 100 && seen.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 200));
      expect(seen).toHaveLength(1);
      // The pool replaces the dead client.
      const again = await dbInternals(db).drizzle.execute(sql`select 1 as one`);
      expect(again.rows[0]).toEqual({ one: 1 });
    } finally {
      await db.close();
    }
  });
});
