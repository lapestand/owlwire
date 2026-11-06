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
import { revokeAppInstallations, setApprovalStatus } from '../system/apps.js';
import { findInstallationByTokenHash } from '../system/lookups.js';
import { createApp } from './apps.js';
import { SYSTEM_ACTOR } from './audit.js';
import {
  createInstallation,
  getInstallation,
  getInstallationWithApp,
  listInstallationsWithApp,
  revokeInstallation,
  updateInstallationGrants,
} from './installations.js';

let env: DbTestEnv;
let A: string;
let B: string;

const inWs =
  (ws: string) =>
  <T>(fn: (t: TenantTx) => Promise<T>) =>
    withTenant(env.db, tenantScope(ws), fn);
const sys = <T>(fn: (s: SystemTx) => Promise<T>) => withSystem(env.db, SYSTEM, fn);

beforeAll(async () => {
  env = await setupDbTestEnv();
  A = await createTestWorkspace(env.db, 'alpha');
  B = await createTestWorkspace(env.db, 'bravo');
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

async function setup(
  opts: {
    visibility?: 'private' | 'public';
    installIn?: string;
    grantedTypes?: string[] | null;
  } = {},
) {
  const issued = issueToken('inst');
  const app = await inWs(A)((t) =>
    createApp(
      t,
      {
        name: 'Plate reader',
        slug: `plate-${newId().slice(-12)}`,
        visibility: opts.visibility ?? 'private',
      },
      SYSTEM_ACTOR,
    ),
  );
  // Public apps start pending; only an approved one is visible to, and installable by, other workspaces.
  if (opts.visibility === 'public')
    await sys((s) => setApprovalStatus(s, app.id, 'approved', SYSTEM_ACTOR));
  const ws = opts.installIn ?? A;
  const inst = await inWs(ws)((t) =>
    createInstallation(
      t,
      {
        appId: app.id,
        tokenHash: issued.hash,
        tokenPrefix: issued.prefix,
        externalRef: 'gate-1',
        grantedTypes: opts.grantedTypes ?? null,
      },
      SYSTEM_ACTOR,
    ),
  );
  return { app, inst, issued, ws };
}

describe('installations repo: grants, app state and bulk revoke', () => {
  it('lists installations with the app name and visibility', async () => {
    const { inst } = await setup({ grantedTypes: ['generic'] });
    const row = await inWs(A)((t) => getInstallationWithApp(t, inst.id));
    expect(row).toMatchObject({
      appName: 'Plate reader',
      appVisibility: 'private',
      grantedTypes: ['generic'],
    });
    expect((await inWs(A)((t) => listInstallationsWithApp(t))).map((i) => i.id)).toContain(inst.id);
    expect(await inWs(B)((t) => getInstallationWithApp(t, inst.id))).toBeNull();
  });

  it('keeps installations listed after the app lost its approval', async () => {
    const { app, inst } = await setup({ visibility: 'public', installIn: B });
    await env.owner.query(`update apps set approval_status = 'rejected' where id = $1`, [app.id]);
    const row = (await inWs(B)((t) => listInstallationsWithApp(t))).find((i) => i.id === inst.id);
    expect(row).toMatchObject({ appName: null, appVisibility: null, status: 'active' });
  });

  it('finds installations by token hash with app and workspace state', async () => {
    const { inst, issued } = await setup();
    const row = await sys((s) => findInstallationByTokenHash(s, issued.hash));
    expect(row).toMatchObject({
      id: inst.id,
      workspaceId: A,
      tokenHash: issued.hash,
      appVisibility: 'private',
      appApprovalStatus: 'approved',
      appOwnerWorkspaceId: A,
      status: 'active',
      workspaceDeleted: false,
    });
    expect(await sys((s) => findInstallationByTokenHash(s, 'nope'))).toBeNull();
  });

  it('reports deleted workspaces', async () => {
    const gone = await createTestWorkspace(env.db, 'gone');
    const app = await inWs(gone)((t) =>
      createApp(
        t,
        { name: 'Gone', slug: `gone-${newId().slice(-12)}`, visibility: 'private' },
        SYSTEM_ACTOR,
      ),
    );
    const issued = issueToken('inst');
    await inWs(gone)((t) =>
      createInstallation(
        t,
        { appId: app.id, tokenHash: issued.hash, tokenPrefix: issued.prefix },
        SYSTEM_ACTOR,
      ),
    );
    await env.owner.query(`update workspaces set deleted_at = now() where id = $1`, [gone]);
    expect((await sys((s) => findInstallationByTokenHash(s, issued.hash)))?.workspaceDeleted).toBe(
      true,
    );
  });

  it('updates granted types only while active and audits the change', async () => {
    const { inst } = await setup({ grantedTypes: ['generic'] });
    const updated = await inWs(A)((t) => updateInstallationGrants(t, inst.id, null, SYSTEM_ACTOR));
    expect(updated?.grantedTypes).toBeNull();
    await inWs(A)((t) => revokeInstallation(t, inst.id, SYSTEM_ACTOR));
    expect(
      await inWs(A)((t) => updateInstallationGrants(t, inst.id, ['generic'], SYSTEM_ACTOR)),
    ).toBeNull();
    expect((await inWs(A)((t) => getInstallation(t, inst.id)))?.grantedTypes).toBeNull();
    const { rows } = await env.owner.query<{ action: string; data: Record<string, unknown> }>(
      `select action, data from audit_log where target_id = $1 order by created_at, action`,
      [inst.id],
    );
    expect(rows.filter((r) => r.action === 'installation.updated')).toEqual([
      { action: 'installation.updated', data: { grantedTypes: null } },
    ]);
    expect(rows.find((r) => r.action === 'installation.revoked')?.data).toMatchObject({
      reason: 'workspace',
    });
  });

  it('revokes every active installation of a rejected app with reason app_rejected', async () => {
    const { app, inst } = await setup({ visibility: 'public', installIn: B });
    const n = await sys((s) => revokeAppInstallations(s, app.id, SYSTEM_ACTOR));
    expect(n).toBe(1);
    expect((await inWs(B)((t) => getInstallation(t, inst.id)))?.status).toBe('revoked');
    const { rows } = await env.owner.query<{ workspace_id: string; data: Record<string, unknown> }>(
      `select workspace_id, data from audit_log where action = 'installation.revoked' and target_id = $1`,
      [inst.id],
    );
    expect(rows).toEqual([
      { workspace_id: B, data: expect.objectContaining({ reason: 'app_rejected', appId: app.id }) },
    ]);
    expect(await sys((s) => revokeAppInstallations(s, app.id, SYSTEM_ACTOR))).toBe(0);
  });
});
