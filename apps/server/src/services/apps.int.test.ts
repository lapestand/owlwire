import { type AuditActor, listCatalog, tenantScope, withTenant } from '@owlwire/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type AppFixture, createAppFixture } from '../test/app-fixtures.js';
import { createWorkspaceApp, putCatalog, rotateAppKey } from './apps.js';
import { PayloadSchemaRegistry } from './payload-schema.js';
import { type ServiceDeps, serviceDeps } from './types.js';

let fx: AppFixture;
let d: ServiceDeps;
let wsA: string;
let wsB: string;
let actor: AuditActor;
const plain = { isInstanceAdmin: false };

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
  const u = await fx.user();
  actor = { kind: 'user', userId: u.userId };
}, 120_000);

// Tests run shuffled nightly: every test starts from the default edition setting.
beforeEach(() => {
  d.config.publicApps.requireApproval = true;
});

afterAll(async () => {
  await fx?.close();
});

describe('createWorkspaceApp', () => {
  it('auto-installs private apps and returns the token once', async () => {
    const r = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Plate Reader', visibility: 'private' },
      plain,
    );
    expect(r.app).toMatchObject({
      visibility: 'private',
      approvalStatus: 'approved',
      ownerWorkspaceId: wsA,
    });
    expect(r.app.slug).toMatch(/^plate-reader-[0-9a-f]{6}$/);
    expect(r.appKey).toBeNull();
    expect(r.token).toMatch(/^ow_inst_/);
    expect(r.installation).toMatchObject({
      workspaceId: wsA,
      status: 'active',
      grantedTypes: null,
    });
    expect(await auditActions(r.app.id)).toEqual(['app.created']);
    expect(await auditActions(r.installation?.id as string)).toEqual(['installation.created']);
  });

  it('creates pending public apps when approval is required', async () => {
    d.config.publicApps.requireApproval = true;
    const r = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Tracker', visibility: 'public' },
      plain,
    );
    expect(r.app.approvalStatus).toBe('pending');
    expect(r.appKey).toMatch(/^ow_app_/);
    expect(r.app.appKeyPrefix).toBe(r.appKey?.slice(0, 12));
    expect(r.installation).toBeNull();
    expect(await auditActions(r.app.id)).toEqual(['app.created']);
  });

  it('approves public apps when approval is off or the creator is an instance admin', async () => {
    d.config.publicApps.requireApproval = false;
    const off = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Bot', visibility: 'public' },
      plain,
    );
    expect(off.app.approvalStatus).toBe('approved');
    // Created pending in the tenant transaction, then approved in system mode with the reason recorded.
    // (The fake clock does not move, so the two rows share created_at and come back in action order.)
    expect((await auditActions(off.app.id)).sort()).toEqual([
      'app.approval_changed',
      'app.created',
    ]);
    d.config.publicApps.requireApproval = true;
    const byAdmin = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Ops', visibility: 'public' },
      { isInstanceAdmin: true },
    );
    expect(byAdmin.app.approvalStatus).toBe('approved');
  });

  it('records the configuration reason of the initial approval', async () => {
    d.config.publicApps.requireApproval = false;
    const off = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Reasoned', visibility: 'public' },
      plain,
    );
    const byAdmin = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Reasoned', visibility: 'public' },
      { isInstanceAdmin: true },
    );
    const { rows } = await fx.owner.query<{
      target_id: string;
      workspace_id: string;
      data: unknown;
    }>(
      `select target_id, workspace_id, data from audit_log
        where action = 'app.approval_changed' and target_id = any($1::text[])`,
      [[off.app.id, byAdmin.app.id]],
    );
    const byTarget = new Map(rows.map((r) => [r.target_id, r]));
    expect(byTarget.get(off.app.id)).toMatchObject({
      workspace_id: wsA,
      data: { from: 'pending', to: 'approved', note: 'approval_not_required' },
    });
    expect(byTarget.get(byAdmin.app.id)?.data).toEqual({
      from: 'pending',
      to: 'approved',
      note: 'instance_admin',
    });
  });

  it('slugifies Turkish names with the workspace slug rules', async () => {
    const r = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Işık Ğüşçö', visibility: 'private' },
      plain,
    );
    expect(r.app.slug).toMatch(/^isik-gusco-[0-9a-f]{6}$/);
  });
});

describe('rotateAppKey', () => {
  it('returns a new key and a 24 hour grace for the previous one', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Rot', visibility: 'public' },
      plain,
    );
    const r = await rotateAppKey(d, tenantScope(wsA), actor, app.id);
    expect(r.appKey).toMatch(/^ow_app_/);
    expect(r.appKeyPrefix).toBe(r.appKey.slice(0, 12));
    expect(r.previousKeyExpiresAt?.toISOString()).toBe('2026-10-13T09:00:00.000Z');
    expect(await auditActions(app.id)).toEqual(['app.created', 'app.key_rotated']);
  });

  it('gives a private app its first key without a grace period', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Keyless', visibility: 'private' },
      plain,
    );
    const r = await rotateAppKey(d, tenantScope(wsA), actor, app.id);
    expect(r.appKey).toMatch(/^ow_app_/);
    expect(r.previousKeyExpiresAt).toBeNull();
  });

  it('hides apps of other workspaces', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Mine', visibility: 'public' },
      plain,
    );
    await expect(rotateAppKey(d, tenantScope(wsB), actor, app.id)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
    });
  });
});

describe('putCatalog', () => {
  it('upserts types and returns the whole catalog', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Cat', visibility: 'private' },
      plain,
    );
    const types = await putCatalog(d, tenantScope(wsA), actor, app.id, [
      {
        key: 'attack.incoming',
        name: 'Incoming attack',
        defaultSeverity: 'high',
        payloadSchema: { type: 'object' },
      },
    ]);
    expect(types.map((x) => x.key)).toEqual(['attack.incoming', 'generic']);
    expect(await auditActions(app.id)).toContain('catalog.updated');
  });

  it('rejects invalid payload schemas with 422', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Bad', visibility: 'private' },
      plain,
    );
    await expect(
      putCatalog(d, tenantScope(wsA), actor, app.id, [
        { key: 'x', name: 'X', defaultSeverity: 'info', payloadSchema: { type: 'nope' } },
      ]),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
    const keys = await withTenant(fx.deps.db, tenantScope(wsA), (t) => listCatalog(t, app.id));
    expect(keys.map((x) => x.key)).toEqual(['generic']);
  });

  it('refuses reserved and duplicate keys without touching the catalog', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Guard', visibility: 'private' },
      plain,
    );
    for (const types of [
      [{ key: 'generic', name: 'Mine now', defaultSeverity: 'critical' as const }],
      [{ key: 'owlwire.test', name: 'Reserved', defaultSeverity: 'info' as const }],
      [
        { key: 'a.b', name: 'One', defaultSeverity: 'info' as const },
        { key: 'a.b', name: 'Two', defaultSeverity: 'low' as const },
      ],
    ]) {
      await expect(putCatalog(d, tenantScope(wsA), actor, app.id, types)).rejects.toMatchObject({
        status: 422,
        code: 'validation_failed',
      });
    }
    const rows = await withTenant(fx.deps.db, tenantScope(wsA), (t) => listCatalog(t, app.id));
    expect(rows).toEqual([expect.objectContaining({ key: 'generic', defaultSeverity: 'info' })]);
    expect(await auditActions(app.id)).toEqual(['app.created']);
  });

  it('refuses an unknown severity', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Sev', visibility: 'private' },
      plain,
    );
    const bad = { key: 'x', name: 'X', defaultSeverity: 'urgent' } as unknown as {
      key: string;
      name: string;
      defaultSeverity: 'info';
    };
    await expect(putCatalog(d, tenantScope(wsA), actor, app.id, [bad])).rejects.toMatchObject({
      status: 422,
      code: 'validation_failed',
    });
  });

  it('reports an unavailable validator as a retryable server condition', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Busy', visibility: 'private' },
      plain,
    );
    const closed = new PayloadSchemaRegistry();
    await closed.close();
    await expect(
      putCatalog({ ...d, payloadSchemas: closed }, tenantScope(wsA), actor, app.id, [
        { key: 'x', name: 'X', defaultSeverity: 'info', payloadSchema: { type: 'object' } },
      ]),
    ).rejects.toMatchObject({ status: 503, code: 'unavailable' });
  });

  it('refuses to edit catalogs of other workspaces', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Other', visibility: 'private' },
      plain,
    );
    await expect(
      putCatalog(d, tenantScope(wsB), actor, app.id, [
        { key: 'x', name: 'X', defaultSeverity: 'info' },
      ]),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('checks ownership before compiling any payload schema', async () => {
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actor,
      { name: 'Owned first', visibility: 'private' },
      plain,
    );
    let compiled = 0;
    const counting = Object.create(d.payloadSchemas) as PayloadSchemaRegistry;
    counting.checkSchema = (schema) => {
      compiled++;
      return d.payloadSchemas.checkSchema(schema);
    };
    await expect(
      putCatalog({ ...d, payloadSchemas: counting }, tenantScope(wsB), actor, app.id, [
        { key: 'x', name: 'X', defaultSeverity: 'info', payloadSchema: { type: 'object' } },
      ]),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    expect(compiled).toBe(0);
  });
});
