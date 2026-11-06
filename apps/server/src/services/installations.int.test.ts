import { type AuditActor, tenantScope } from '@owlwire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppFixture, createAppFixture } from '../test/app-fixtures.js';
import { createWorkspaceApp, putCatalog } from './apps.js';
import {
  changeInstallationGrants,
  changeInstallationSourceTemplate,
  createWorkspaceInstallation,
  revokeWorkspaceInstallation,
} from './installations.js';
import { createWorkspaceSourceTemplate } from './source-templates.js';
import { type ServiceDeps, serviceDeps } from './types.js';

let fx: AppFixture;
let d: ServiceDeps;
let wsA: string;
let wsB: string;
let adminA: AuditActor;
let adminB: AuditActor;
let adminBId: string;
const plain = { isInstanceAdmin: false };

async function publicApp(approval: 'approved' | 'pending') {
  d.config.publicApps.requireApproval = approval === 'pending';
  const { app } = await createWorkspaceApp(
    d,
    tenantScope(wsA),
    adminA,
    { name: 'Tracker', visibility: 'public' },
    plain,
  );
  await putCatalog(d, tenantScope(wsA), adminA, app.id, [
    { key: 'account.inactive', name: 'Inactive', defaultSeverity: 'medium' },
    { key: 'attack.incoming', name: 'Attack', defaultSeverity: 'high' },
  ]);
  return app;
}

async function auditActions(targetId: string): Promise<string[]> {
  const { rows } = await fx.owner.query<{ action: string }>(
    `select action from audit_log where target_id = $1 order by created_at, action`,
    [targetId],
  );
  return rows.map((r) => r.action);
}

beforeAll(async () => {
  fx = await createAppFixture();
  d = serviceDeps(fx.deps);
  wsA = await fx.workspace('alpha');
  wsB = await fx.workspace('beta');
  adminA = { kind: 'user', userId: (await fx.user()).userId };
  adminBId = (await fx.user()).userId;
  adminB = { kind: 'user', userId: adminBId };
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

describe('createWorkspaceInstallation', () => {
  it('installs an approved public app into another workspace with deduplicated grants', async () => {
    const app = await publicApp('approved');
    const r = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
      grantedTypes: ['attack.incoming', 'attack.incoming'],
      externalRef: 'alliance-4711',
    });
    expect(r.token).toMatch(/^ow_inst_/);
    expect(r.installation).toMatchObject({
      workspaceId: wsB,
      appId: app.id,
      appName: 'Tracker',
      appVisibility: 'public',
      grantedTypes: ['attack.incoming'],
      externalRef: 'alliance-4711',
      createdByUserId: adminBId,
    });
  });

  it('rejects grants that are not in the catalog', async () => {
    const app = await publicApp('approved');
    await expect(
      createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
        appId: app.id,
        grantedTypes: ['nope'],
      }),
    ).rejects.toMatchObject({ status: 422, code: 'unknown_type' });
  });

  it('hides pending public apps from other workspaces and blocks the owner with app_not_approved', async () => {
    const app = await publicApp('pending');
    await expect(
      createWorkspaceInstallation(d, tenantScope(wsB), adminB, { appId: app.id }),
    ).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
    await expect(
      createWorkspaceInstallation(d, tenantScope(wsA), adminA, { appId: app.id }),
    ).rejects.toMatchObject({
      status: 403,
      code: 'app_not_approved',
    });
  });

  it('hides private apps of other workspaces', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      adminA,
      { name: 'Gate', visibility: 'private' },
      plain,
    );
    await expect(
      createWorkspaceInstallation(d, tenantScope(wsB), adminB, { appId: app.id }),
    ).rejects.toMatchObject({
      code: 'not_found',
    });
    const extra = await createWorkspaceInstallation(d, tenantScope(wsA), adminA, {
      appId: app.id,
    });
    expect(extra.installation.workspaceId).toBe(wsA);
  });
});

describe('revoke and grants', () => {
  it('revokes once, audits once and blocks later grant changes', async () => {
    const app = await publicApp('approved');
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
    });
    await revokeWorkspaceInstallation(d, tenantScope(wsB), adminB, installation.id);
    await revokeWorkspaceInstallation(d, tenantScope(wsB), adminB, installation.id);
    const { rows } = await fx.owner.query<{ data: { reason: string } }>(
      `select data from audit_log where target_id = $1 and action = 'installation.revoked'`,
      [installation.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.data.reason).toBe('workspace');
    await expect(
      changeInstallationGrants(d, tenantScope(wsB), adminB, installation.id, null),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('does not let another workspace revoke', async () => {
    const app = await publicApp('approved');
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
    });
    await expect(
      revokeWorkspaceInstallation(d, tenantScope(wsA), adminA, installation.id),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('updates grants to a validated set', async () => {
    const app = await publicApp('approved');
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
    });
    const r = await changeInstallationGrants(d, tenantScope(wsB), adminB, installation.id, [
      'account.inactive',
    ]);
    expect(r.grantedTypes).toEqual(['account.inactive']);
    await expect(
      changeInstallationGrants(d, tenantScope(wsB), adminB, installation.id, ['missing']),
    ).rejects.toMatchObject({ status: 422, code: 'unknown_type' });
  });

  it('skips the write and the audit row when the grants do not change', async () => {
    const app = await publicApp('approved');
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
      grantedTypes: ['attack.incoming'],
    });
    const same = await changeInstallationGrants(d, tenantScope(wsB), adminB, installation.id, [
      'attack.incoming',
      'attack.incoming',
    ]);
    expect(same.grantedTypes).toEqual(['attack.incoming']);
    expect(await auditActions(installation.id)).toEqual(['installation.created']);
    const all = await changeInstallationGrants(d, tenantScope(wsB), adminB, installation.id, null);
    expect(all.grantedTypes).toBeNull();
    expect(await auditActions(installation.id)).toEqual([
      'installation.created',
      'installation.updated',
    ]);
  });

  it('hides installations of other workspaces from grant changes', async () => {
    const app = await publicApp('approved');
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
    });
    await expect(
      changeInstallationGrants(d, tenantScope(wsA), adminA, installation.id, null),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});

describe('source template binding', () => {
  const mapping = { type: 'generic', body: '{{payload.text}}' };
  const template = (ws: string, actor: AuditActor, key: string) =>
    createWorkspaceSourceTemplate(d, tenantScope(ws), actor, { key, name: key, mapping });

  it('binds on create, rebinds and unbinds later', async () => {
    const app = await publicApp('approved');
    const first = await template(wsB, adminB, 'bind-first');
    const second = await template(wsB, adminB, 'bind-second');
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
      sourceTemplateId: first.id,
    });
    expect(installation.sourceTemplateId).toBe(first.id);
    const moved = await changeInstallationSourceTemplate(
      d,
      tenantScope(wsB),
      adminB,
      installation.id,
      second.id,
    );
    expect(moved.sourceTemplateId).toBe(second.id);
    const cleared = await changeInstallationSourceTemplate(
      d,
      tenantScope(wsB),
      adminB,
      installation.id,
      null,
    );
    expect(cleared.sourceTemplateId).toBeNull();
  });

  it('rejects a template of another workspace or an unknown one with the same 422', async () => {
    const app = await publicApp('approved');
    const foreign = await template(wsA, adminA, 'foreign-one');
    const unknown = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    for (const id of [foreign.id, unknown]) {
      await expect(
        createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
          appId: app.id,
          sourceTemplateId: id,
        }),
      ).rejects.toMatchObject({
        status: 422,
        code: 'validation_failed',
        detail: 'unknown source template',
      });
    }
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
    });
    await expect(
      changeInstallationSourceTemplate(d, tenantScope(wsB), adminB, installation.id, foreign.id),
    ).rejects.toMatchObject({ status: 422, detail: 'unknown source template' });
  });

  it('refuses to bind a revoked installation', async () => {
    const app = await publicApp('approved');
    const t = await template(wsB, adminB, 'revoked-bind');
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
    });
    await revokeWorkspaceInstallation(d, tenantScope(wsB), adminB, installation.id);
    await expect(
      changeInstallationSourceTemplate(d, tenantScope(wsB), adminB, installation.id, t.id),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });

  it('hides installations of other workspaces', async () => {
    const app = await publicApp('approved');
    const { installation } = await createWorkspaceInstallation(d, tenantScope(wsB), adminB, {
      appId: app.id,
    });
    await expect(
      changeInstallationSourceTemplate(d, tenantScope(wsA), adminA, installation.id, null),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
