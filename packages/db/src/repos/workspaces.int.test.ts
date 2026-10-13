import { randomUUID } from 'node:crypto';
import { newId } from '@owlwire/core';
import {
  createKeyring,
  DecryptError,
  generateKek,
  UnknownKekVersionError,
  unwrapWorkspaceDek,
} from '@owlwire/crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { RepoConflictError, WorkspaceKeyMissingError } from '../errors.js';
import { workspaceKeys, workspaces } from '../schema/index.js';
import { SYSTEM, tenantScope, withTenant } from '../scope.js';
import { backfillWorkspaceKeys } from '../system/workspace-keys.js';
import { listAuditLog, SYSTEM_ACTOR } from './audit.js';
import { q } from './context.js';
import { insertWorkspaceKey, loadWorkspaceDek } from './workspace-keys.js';
import { createWorkspace, getWorkspace } from './workspaces.js';

let env: DbTestEnv;

beforeAll(async () => {
  env = await setupDbTestEnv();
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

async function insertLegacyWorkspace(): Promise<string> {
  const id = randomUUID();
  await env.owner.query(
    "insert into workspaces (id, name, slug, kind) values ($1, 'legacy', $2, 'community')",
    [id, `legacy-${id}`],
  );
  return id;
}

describe('createWorkspace', () => {
  it('creates the workspace, a wrapped DEK and an audit entry in one transaction', async () => {
    const id = await createTestWorkspace(env.db, 'alpha');
    const { rows } = await env.owner.query(
      'select kek_version, length(wrapped_dek) as len from workspace_keys where workspace_id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ kek_version: 1, len: 1 + 12 + 32 + 16 });
    const dek = await withTenant(env.db, tenantScope(id), (t) => loadWorkspaceDek(t));
    expect(dek.length).toBe(32);
    const audit = await withTenant(env.db, tenantScope(id), (t) => listAuditLog(t));
    expect(audit.map((a) => a.action)).toEqual(['workspace.created']);
    expect(audit[0]).toMatchObject({
      workspaceId: id,
      targetType: 'workspace',
      targetId: id,
      actorUserId: null,
      data: { kind: 'community', slug: `alpha-${id.slice(-12)}` },
    });
  });

  it('returns the inserted row', async () => {
    const id = newId();
    const slug = `ret-${randomUUID()}`;
    const row = await withTenant(env.db, tenantScope(id), (t) =>
      createWorkspace(t, { name: 'Ret', slug, kind: 'personal' }, SYSTEM_ACTOR),
    );
    expect(row).toMatchObject({ id, name: 'Ret', slug, kind: 'personal', deletedAt: null });
    expect(row.createdAt).toEqual(env.clock.now());
  });

  it('gives each workspace a different DEK', async () => {
    const a = await createTestWorkspace(env.db, 'a');
    const b = await createTestWorkspace(env.db, 'b');
    const dekA = await withTenant(env.db, tenantScope(a), (t) => loadWorkspaceDek(t));
    const dekB = await withTenant(env.db, tenantScope(b), (t) => loadWorkspaceDek(t));
    expect(dekA.equals(dekB)).toBe(false);
  });

  it('rejects a duplicate slug with RepoConflictError and leaves no key behind', async () => {
    const slug = `dup-${randomUUID()}`;
    const first = newId();
    await withTenant(env.db, tenantScope(first), (t) =>
      createWorkspace(t, { name: 'x', slug, kind: 'community' }, SYSTEM_ACTOR),
    );
    const second = newId();
    await expect(
      withTenant(env.db, tenantScope(second), (t) =>
        createWorkspace(t, { name: 'y', slug, kind: 'community' }, SYSTEM_ACTOR),
      ),
    ).rejects.toBeInstanceOf(RepoConflictError);
    const { rows } = await env.owner.query(
      'select count(*)::int as n from workspace_keys where workspace_id = $1',
      [second],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('getWorkspace returns only the scoped workspace', async () => {
    const a = await createTestWorkspace(env.db, 'ga');
    const b = await createTestWorkspace(env.db, 'gb');
    expect((await withTenant(env.db, tenantScope(a), (t) => getWorkspace(t)))?.id).toBe(a);
    const fromB = await withTenant(env.db, tenantScope(b), (t) => getWorkspace(t));
    expect(fromB?.id).toBe(b);
  });

  it('getWorkspace returns null when the scoped workspace does not exist', async () => {
    expect(await withTenant(env.db, tenantScope(newId()), (t) => getWorkspace(t))).toBeNull();
  });

  it('cannot unwrap with a keyring that lacks the stored version', async () => {
    const id = await createTestWorkspace(env.db, 'kv');
    const other = env.open(createKeyring(generateKek(7)));
    await expect(
      withTenant(other, tenantScope(id), (t) => loadWorkspaceDek(t)),
    ).rejects.toBeInstanceOf(UnknownKekVersionError);
  });

  it('a second key for the same workspace is a conflict unless ifMissing is set', async () => {
    const id = await createTestWorkspace(env.db, 'twice');
    await expect(
      withTenant(env.db, tenantScope(id), (t) => insertWorkspaceKey(t)),
    ).rejects.toBeInstanceOf(RepoConflictError);
    expect(
      await withTenant(env.db, tenantScope(id), (t) => insertWorkspaceKey(t, { ifMissing: true })),
    ).toBe(false);
  });

  it('cannot create a workspace whose id differs from the tenant scope (RLS)', async () => {
    const scoped = newId();
    const foreign = newId();
    await expect(
      withTenant(env.db, tenantScope(scoped), (t) =>
        q(t)
          .insert(workspaces)
          .values({ id: foreign, name: 'f', slug: `f-${foreign}`, kind: 'community' }),
      ),
    ).rejects.toThrow();
    const { rows } = await env.owner.query(
      'select count(*)::int as n from workspaces where id = $1',
      [foreign],
    );
    expect(rows[0]?.n).toBe(0);
  });
});

describe('cross-tenant isolation (R121)', () => {
  it('tenant A cannot read workspace B or its key, and B cannot be read from A', async () => {
    const a = await createTestWorkspace(env.db, 'xa');
    const b = await createTestWorkspace(env.db, 'xb');
    const seen = await withTenant(env.db, tenantScope(a), async (t) => ({
      own: await getWorkspace(t),
      ws: await q(t).select().from(workspaces).where(eq(workspaces.id, b)),
      key: await q(t).select().from(workspaceKeys).where(eq(workspaceKeys.workspaceId, b)),
      allWs: await q(t).select({ id: workspaces.id }).from(workspaces),
      allKeys: await q(t).select({ id: workspaceKeys.workspaceId }).from(workspaceKeys),
    }));
    expect(seen.own?.id).toBe(a);
    expect(seen.ws).toEqual([]);
    expect(seen.key).toEqual([]);
    expect(seen.allWs.map((r) => r.id)).toEqual([a]);
    expect(seen.allKeys.map((r) => r.id)).toEqual([a]);
  });

  it('a workspace without a visible key fails with WorkspaceKeyMissingError', async () => {
    const legacy = await insertLegacyWorkspace();
    await expect(
      withTenant(env.db, tenantScope(legacy), (t) => loadWorkspaceDek(t)),
    ).rejects.toBeInstanceOf(WorkspaceKeyMissingError);
    await backfillWorkspaceKeys(SYSTEM, env.db);
  });

  it("B's wrapped DEK does not unwrap under A's AAD", async () => {
    const a = await createTestWorkspace(env.db, 'aad-a');
    const b = await createTestWorkspace(env.db, 'aad-b');
    const { rows } = await env.owner.query<{ wrapped_dek: Buffer; kek_version: number }>(
      'select wrapped_dek, kek_version from workspace_keys where workspace_id = $1',
      [b],
    );
    const row = rows[0];
    if (!row) throw new Error('missing key row');
    expect(unwrapWorkspaceDek(env.keyring, row.wrapped_dek, row.kek_version, b).length).toBe(32);
    expect(() => unwrapWorkspaceDek(env.keyring, row.wrapped_dek, row.kek_version, a)).toThrow(
      DecryptError,
    );
  });

  it("a key row copied from B into A's slot does not unwrap in A's scope", async () => {
    const a = await createTestWorkspace(env.db, 'swap-a');
    const b = await createTestWorkspace(env.db, 'swap-b');
    await env.owner.query(
      'update workspace_keys set wrapped_dek = (select wrapped_dek from workspace_keys where workspace_id = $2) where workspace_id = $1',
      [a, b],
    );
    await expect(
      withTenant(env.db, tenantScope(a), (t) => loadWorkspaceDek(t)),
    ).rejects.toBeInstanceOf(DecryptError);
  });

  it("A's audit log holds only A's create entry", async () => {
    const a = await createTestWorkspace(env.db, 'aud-a');
    await createTestWorkspace(env.db, 'aud-b');
    const audit = await withTenant(env.db, tenantScope(a), (t) => listAuditLog(t));
    expect(audit.map((r) => [r.action, r.targetId])).toEqual([['workspace.created', a]]);
  });
});

describe('backfillWorkspaceKeys', () => {
  it('creates keys for workspaces that have none, exactly once', async () => {
    const legacy = await insertLegacyWorkspace();
    expect(await backfillWorkspaceKeys(SYSTEM, env.db)).toBe(1);
    expect(await backfillWorkspaceKeys(SYSTEM, env.db)).toBe(0);
    const dek = await withTenant(env.db, tenantScope(legacy), (t) => loadWorkspaceDek(t));
    expect(dek.length).toBe(32);
    const audit = await withTenant(env.db, tenantScope(legacy), (t) => listAuditLog(t));
    expect(audit.map((a) => a.action)).toEqual(['keys.dek_created']);
  });

  it('is safe to run concurrently: no duplicate keys, no failures, one audit entry each', async () => {
    const ids = await Promise.all([1, 2, 3].map(() => insertLegacyWorkspace()));
    const counts = await Promise.all([
      backfillWorkspaceKeys(SYSTEM, env.db),
      backfillWorkspaceKeys(SYSTEM, env.db),
    ]);
    expect(counts[0] + counts[1]).toBe(3);
    const { rows } = await env.owner.query<{ workspace_id: string; n: number }>(
      'select workspace_id, count(*)::int as n from workspace_keys where workspace_id = any($1) group by workspace_id',
      [ids],
    );
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.n === 1)).toBe(true);
    const audit = await env.owner.query<{ n: number }>(
      "select count(*)::int as n from audit_log where action = 'keys.dek_created' and workspace_id = any($1)",
      [ids],
    );
    expect(audit.rows[0]?.n).toBe(3);
  });
});
