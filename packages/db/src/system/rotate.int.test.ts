import { createKeyring, generateKek, type Kek } from '@owlwire/crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import type { OwlwireDb } from '../handle.js';
import { listAuditLog, SYSTEM_ACTOR } from '../repos/audit.js';
import { createConnection, readConnectionConfig } from '../repos/connections.js';
import { SYSTEM, tenantScope, withTenant } from '../scope.js';
import { rotateWorkspaceKeys } from './workspace-keys.js';

let env: DbTestEnv;
const seeded: Array<{ ws: string; connectionId: string; token: string }> = [];
let v1: Kek;
const v2 = generateKek(2);
const v3 = generateKek(3);
const v4 = generateKek(4);
const v5 = generateKek(5);
const v6 = generateKek(6);
const v7 = generateKek(7);

async function versions(): Promise<Record<number, number>> {
  const { rows } = await env.owner.query<{ v: number; n: number }>(
    'select kek_version as v, count(*)::int as n from workspace_keys group by 1 order by 1',
  );
  return Object.fromEntries(rows.map((r) => [r.v, r.n]));
}

async function expectAllConfigsReadable(db: OwlwireDb): Promise<void> {
  for (const s of seeded) {
    const config = await withTenant(db, tenantScope(s.ws), (t) =>
      readConnectionConfig(t, s.connectionId, { purpose: 'send' }),
    );
    expect(config).toEqual({ botToken: s.token });
  }
}

/** Seeds six workspaces whose DEKs are wrapped with `kek`, each with one connection holding a sealed token. */
async function seedWorkspaces(kek: Kek): Promise<void> {
  const db = env.open(createKeyring(kek));
  for (let i = 0; i < 6; i++) {
    const ws = await createTestWorkspace(db, `rot${i}`);
    const token = `token-${i}`;
    const conn = await withTenant(db, tenantScope(ws), (t) =>
      createConnection(
        t,
        { platform: 'telegram', kind: 'own_bot', displayName: 'b', config: { botToken: token } },
        SYSTEM_ACTOR,
      ),
    );
    seeded.push({ ws, connectionId: conn.id, token });
  }
}

beforeAll(async () => {
  env = await setupDbTestEnv();
  v1 = env.keyring.current;
}, 120_000);

// Every test starts from an empty database and seeds its own workspaces, wrapped with the KEK version it
// rotates away from, so the tests pass in any order.
beforeEach(async () => {
  await env.owner.query('truncate workspaces, audit_log cascade');
  seeded.length = 0;
});

afterAll(async () => {
  await env?.stop();
});

describe('rotateWorkspaceKeys', () => {
  it('re-wraps every key to the current version without changing the DEKs', async () => {
    await seedWorkspaces(v1);
    const result = await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v2, v1)), {
      batchSize: 4,
    });
    expect(result).toMatchObject({ currentVersion: 2, rotated: 6, failed: [] });
    expect(result.remainingByVersion.size).toBe(0);
    expect(await versions()).toEqual({ 2: 6 });
    await expectAllConfigsReadable(env.open(createKeyring(v2)));
    const audit = await withTenant(env.db, tenantScope(seeded[0]?.ws ?? ''), (t) =>
      listAuditLog(t, { limit: 1 }),
    );
    expect(audit[0]).toMatchObject({
      action: 'keys.kek_rotated',
      targetType: 'keys',
      targetId: seeded[0]?.ws,
      data: { fromVersion: 1, toVersion: 2 },
    });
  });

  it('is idempotent', async () => {
    await seedWorkspaces(v1);
    expect((await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v2, v1)))).rotated).toBe(6);
    const result = await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v2, v1)));
    expect(result.rotated).toBe(0);
    expect(await versions()).toEqual({ 2: 6 });
  });

  it('resumes after an interruption and stays readable in between', async () => {
    await seedWorkspaces(v2);
    const db = env.open(createKeyring(v3, v2));
    let seen = 0;
    await expect(
      rotateWorkspaceKeys(SYSTEM, db, {
        onRotated: () => {
          seen++;
          if (seen === 2) throw new Error('simulated crash');
        },
      }),
    ).rejects.toThrow('simulated crash');
    expect(await versions()).toEqual({ 2: 4, 3: 2 });
    await expectAllConfigsReadable(db);
    const result = await rotateWorkspaceKeys(SYSTEM, db);
    expect(result.rotated).toBe(4);
    expect(await versions()).toEqual({ 3: 6 });
  });

  it('does not double-rotate when two runs race', async () => {
    await seedWorkspaces(v3);
    const [a, b] = await Promise.all([
      rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v4, v3)), { batchSize: 2 }),
      rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v4, v3)), { batchSize: 2 }),
    ]);
    expect(a.failed).toEqual([]);
    expect(b.failed).toEqual([]);
    expect(a.rotated + b.rotated).toBe(6);
    expect(await versions()).toEqual({ 4: 6 });
    await expectAllConfigsReadable(env.open(createKeyring(v4)));
    const { rows } = await env.owner.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'keys.kek_rotated' and data->>'toVersion' = '4'",
    );
    expect(rows[0]?.n).toBe(6);
  });

  it('reports keys wrapped with an unknown version and rotates the rest', async () => {
    await seedWorkspaces(v4);
    const broken = seeded[5]?.ws ?? '';
    await env.owner.query('update workspace_keys set kek_version = 1 where workspace_id = $1', [
      broken,
    ]);
    const result = await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v5, v4)));
    expect(result.rotated).toBe(5);
    expect(result.failed.map((f) => f.workspaceId)).toEqual([broken]);
    expect(result.failed[0]?.error).toContain('UnknownKekVersionError');
    expect(result.remainingByVersion).toEqual(new Map([[1, 1]]));
    // Repair: the key is really wrapped with v4; a re-run with v4 as previous finishes it.
    await env.owner.query('update workspace_keys set kek_version = 4 where workspace_id = $1', [
      broken,
    ]);
    const rerun = await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v5, v4)));
    expect(rerun).toMatchObject({ rotated: 1, failed: [] });
    expect(rerun.remainingByVersion.size).toBe(0);
    expect(await versions()).toEqual({ 5: 6 });
  });

  it('reports a wrong previous key by name and version only', async () => {
    await seedWorkspaces(v5);
    const wrong = generateKek(5);
    const result = await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v6, wrong)));
    expect(result.rotated).toBe(0);
    expect(result.failed).toHaveLength(6);
    for (const f of result.failed) {
      expect(f.error).toBe('DecryptError: KEK v5 does not open the wrapped workspace key');
    }
    expect(result.remainingByVersion).toEqual(new Map([[5, 6]]));
    expect(await versions()).toEqual({ 5: 6 });
  });

  it('rotates soft-deleted workspaces and skips one that vanishes mid-run', async () => {
    await seedWorkspaces(v5);
    const softDeleted = seeded[1]?.ws ?? '';
    await env.owner.query('update workspaces set deleted_at = now() where id = $1', [softDeleted]);
    // UUIDv7: created last, so it sorts after the seeded workspaces in the same listed batch.
    const vanishing = await createTestWorkspace(env.open(createKeyring(v5)), 'rot-vanish');
    expect(await versions()).toEqual({ 5: 7 });
    let deleted = false;
    const result = await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v6, v5)), {
      onRotated: async () => {
        if (deleted) return;
        deleted = true;
        await env.owner.query('delete from workspaces where id = $1', [vanishing]);
      },
    });
    expect(result).toMatchObject({ currentVersion: 6, rotated: 6, failed: [] });
    expect(result.remainingByVersion.size).toBe(0);
    expect(await versions()).toEqual({ 6: 6 });
    const { rows } = await env.owner.query<{ v: number }>(
      'select kek_version as v from workspace_keys where workspace_id = $1',
      [softDeleted],
    );
    expect(rows[0]?.v).toBe(6);
    await expectAllConfigsReadable(env.open(createKeyring(v6)));
  });

  it('writes only versions to the audit log', async () => {
    await seedWorkspaces(v6);
    await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v7, v6)));
    const { rows } = await env.owner.query<{ data: unknown; target_id: string }>(
      "select data, target_id from audit_log where action = 'keys.kek_rotated' and data->>'toVersion' = '7'",
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.data).toEqual({ fromVersion: 6, toVersion: 7 });
    }
  });

  it('never re-wraps a newer key down when OWLWIRE_KEK and OWLWIRE_KEK_PREVIOUS are swapped', async () => {
    await seedWorkspaces(v7);
    expect(await versions()).toEqual({ 7: 6 });
    const { rows: before } = await env.owner.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'keys.kek_rotated'",
    );
    const result = await rotateWorkspaceKeys(SYSTEM, env.open(createKeyring(v6, v7)));
    expect(result).toMatchObject({ currentVersion: 6, rotated: 0, failed: [] });
    expect(result.remainingByVersion).toEqual(new Map([[7, 6]]));
    expect(await versions()).toEqual({ 7: 6 });
    const { rows: after } = await env.owner.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'keys.kek_rotated'",
    );
    expect(after[0]?.n).toBe(before[0]?.n);
    await expectAllConfigsReadable(env.open(createKeyring(v7)));
  });
});
