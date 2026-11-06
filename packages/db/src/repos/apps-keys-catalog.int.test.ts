import { newId } from '@owlwire/core';
import { issueToken } from '@owlwire/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import {
  SYSTEM,
  type SystemTx,
  type TenantTx,
  tenantScope,
  withSystem,
  withTenant,
} from '../scope.js';
import { findAppByKeyHash, listPendingPublicApps, setApprovalStatus } from '../system/apps.js';
import { type CreateAppInput, createApp, getApp, listInstallableApps, setAppKey } from './apps.js';
import { SYSTEM_ACTOR } from './audit.js';
import { listCatalog, upsertCatalogTypes } from './catalog.js';

let env: DbTestEnv;
let A: string;
let B: string;

const inA = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(A), fn);
const inB = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(B), fn);
const sys = <T>(fn: (s: SystemTx) => Promise<T>) => withSystem(env.db, SYSTEM, fn);

beforeAll(async () => {
  env = await setupDbTestEnv();
  A = await createTestWorkspace(env.db, 'alpha');
  B = await createTestWorkspace(env.db, 'bravo');
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

function makeApp(inWs: typeof inA, over: Partial<CreateAppInput> = {}) {
  const suffix = newId().slice(-12);
  return inWs((t) =>
    createApp(
      t,
      { name: 'Tracker', slug: `tracker-${suffix}`, visibility: 'private', ...over },
      SYSTEM_ACTOR,
    ),
  );
}

async function auditRows(targetId: string) {
  const { rows } = await env.owner.query<{
    action: string;
    target_type: string;
    workspace_id: string | null;
    data: Record<string, unknown>;
  }>(
    `select action, target_type, workspace_id, data from audit_log where target_id = $1 order by created_at, action`,
    [targetId],
  );
  return rows;
}

describe('apps repo: keys, approval and installable apps', () => {
  it('creates the generic catalog type with every app', async () => {
    const app = await makeApp(inA);
    const catalog = await inA((t) => listCatalog(t, app.id));
    expect(catalog.map((c) => [c.key, c.defaultSeverity])).toEqual([['generic', 'info']]);
  });

  it('starts public apps as pending and stores the initial app key given at creation', async () => {
    const key = issueToken('app');
    const app = await makeApp(inA, { visibility: 'public', appKey: key });
    expect(app.approvalStatus).toBe('pending');
    expect(app.appKeyPrefix).toBe(key.prefix);
    expect((await auditRows(app.id)).map((r) => r.action)).toEqual(['app.created']);
  });

  it('lets other workspaces see only approved public apps', async () => {
    const priv = await makeApp(inA);
    const pending = await makeApp(inA, { visibility: 'public' });
    const approved = await makeApp(inA, { visibility: 'public' });
    await sys((s) => setApprovalStatus(s, approved.id, 'approved', SYSTEM_ACTOR));
    const ids = (await inB((t) => listInstallableApps(t))).map((a) => a.id);
    expect(ids).toContain(approved.id);
    expect(ids).not.toContain(priv.id);
    expect(ids).not.toContain(pending.id);
    expect(await inB((t) => getApp(t, priv.id))).toBeNull();
    const own = (await inA((t) => listInstallableApps(t))).find((a) => a.id === pending.id);
    expect(own?.owned).toBe(true);
    const foreign = (await inB((t) => listInstallableApps(t))).find((a) => a.id === approved.id);
    expect(foreign?.owned).toBe(false);
  });

  it('rotates app keys keeping the previous key until it expires', async () => {
    const app = await makeApp(inA, { visibility: 'public' });
    const now = new Date('2026-10-12T10:00:00Z');
    const exp = new Date('2026-10-13T10:00:00Z');
    const [k1, k2, k3] = [issueToken('app'), issueToken('app'), issueToken('app')];

    const first = await inA((t) => setAppKey(t, app.id, k1, exp, SYSTEM_ACTOR));
    expect(first).toEqual({ previousKeyExpiresAt: null });
    expect((await sys((s) => findAppByKeyHash(s, k1.hash, now)))?.id).toBe(app.id);

    const second = await inA((t) => setAppKey(t, app.id, k2, exp, SYSTEM_ACTOR));
    expect(second?.previousKeyExpiresAt?.toISOString()).toBe(exp.toISOString());
    expect((await sys((s) => findAppByKeyHash(s, k1.hash, now)))?.id).toBe(app.id);
    expect(await sys((s) => findAppByKeyHash(s, k1.hash, new Date(exp.getTime() + 1)))).toBeNull();
    expect((await sys((s) => findAppByKeyHash(s, k2.hash, new Date(exp.getTime() + 1))))?.id).toBe(
      app.id,
    );

    await inA((t) => setAppKey(t, app.id, k3, exp, SYSTEM_ACTOR));
    expect(await sys((s) => findAppByKeyHash(s, k1.hash, now))).toBeNull();
    expect((await sys((s) => findAppByKeyHash(s, k2.hash, now)))?.id).toBe(app.id);
    expect((await auditRows(app.id)).filter((r) => r.action === 'app.key_rotated')).toHaveLength(3);
  });

  it('does not rotate keys of apps owned by another workspace', async () => {
    const app = await makeApp(inA, { visibility: 'public' });
    const r = await inB((t) =>
      setAppKey(t, app.id, issueToken('app'), new Date('2026-10-13T10:00:00Z'), SYSTEM_ACTOR),
    );
    expect(r).toBeNull();
  });

  it('approves pending public apps through the system scope and audits the change', async () => {
    const app = await makeApp(inA, { visibility: 'public' });
    const pending = (await sys((s) => listPendingPublicApps(s))).find((a) => a.id === app.id);
    expect(pending?.ownerWorkspaceName).toBe('alpha');
    const r = await sys((s) =>
      setApprovalStatus(s, app.id, 'approved', SYSTEM_ACTOR, 'looks fine'),
    );
    expect(r?.from).toBe('pending');
    expect(r?.app.approvalStatus).toBe('approved');
    const audit = (await auditRows(app.id)).find((x) => x.action === 'app.approval_changed');
    expect(audit).toMatchObject({
      workspace_id: A,
      data: { from: 'pending', to: 'approved', note: 'looks fine' },
    });
    const priv = await makeApp(inA);
    expect(await sys((s) => setApprovalStatus(s, priv.id, 'approved', SYSTEM_ACTOR))).toBeNull();
  });
});

describe('catalog repo', () => {
  const type = {
    key: 'attack.incoming',
    name: 'Incoming attack',
    description: null,
    defaultSeverity: 'high' as const,
    payloadSchema: { type: 'object' },
  };

  it('upserts types only for owned apps and audits them', async () => {
    const app = await makeApp(inA);
    expect(await inA((t) => upsertCatalogTypes(t, app.id, [type], SYSTEM_ACTOR))).toBe(true);
    expect(await inB((t) => upsertCatalogTypes(t, app.id, [type], SYSTEM_ACTOR))).toBe(false);
    await inA((t) =>
      upsertCatalogTypes(t, app.id, [{ ...type, name: 'Attack!' }], SYSTEM_ACTOR, {
        via: 'app_key',
      }),
    );
    const catalog = await inA((t) => listCatalog(t, app.id));
    expect(catalog.map((c) => [c.key, c.name, c.defaultSeverity])).toEqual([
      ['attack.incoming', 'Attack!', 'high'],
      ['generic', 'Generic', 'info'],
    ]);
    const audits = (await auditRows(app.id)).filter((r) => r.action === 'catalog.updated');
    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      target_type: 'catalog',
      data: { keys: ['attack.incoming'] },
    });
    expect(audits[1]?.data).toMatchObject({ via: 'app_key', appId: app.id });
  });

  it('hides private catalogs from other workspaces', async () => {
    const app = await makeApp(inA);
    expect(await inB((t) => listCatalog(t, app.id))).toEqual([]);
  });
});
