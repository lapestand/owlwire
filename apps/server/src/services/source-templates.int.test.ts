import { type AuditActor, tenantScope } from '@owlwire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppFixture, createAppFixture } from '../test/app-fixtures.js';
import { createWorkspaceApp } from './apps.js';
import { createWorkspaceInstallation } from './installations.js';
import {
  createWorkspaceSourceTemplate,
  deleteWorkspaceSourceTemplate,
  previewSourceTemplate,
  updateWorkspaceSourceTemplate,
} from './source-templates.js';
import { type ServiceDeps, serviceDeps } from './types.js';

let fx: AppFixture;
let d: ServiceDeps;
let wsA: string;
let wsB: string;
let actorA: AuditActor;
let actorB: AuditActor;
let n = 0;

const mapping = { type: 'generic', body: '{{payload.text}}' };
const nextKey = () => `tpl-${++n}-${Math.random().toString(36).slice(2, 8)}`;

const create = (extra: Record<string, unknown> = {}, ws = wsA, actor = actorA) =>
  createWorkspaceSourceTemplate(d, tenantScope(ws), actor, {
    key: nextKey(),
    name: 'Template',
    mapping,
    ...extra,
  });

beforeAll(async () => {
  fx = await createAppFixture();
  d = serviceDeps(fx.deps);
  wsA = await fx.workspace('alpha');
  wsB = await fx.workspace('beta');
  actorA = { kind: 'user', userId: (await fx.user()).userId };
  actorB = { kind: 'user', userId: (await fx.user()).userId };
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

async function auditCount(): Promise<number> {
  const { rows } = await fx.owner.query<{ c: string }>(`select count(*) c from audit_log`);
  return Number(rows[0]?.c);
}

describe('create and update validation', () => {
  it('creates a user template and returns the row', async () => {
    const row = await create({ description: 'd', samplePayload: { text: 'hi' } });
    expect(row).toMatchObject({ origin: 'user', originRef: null, description: 'd', mapping });
  });

  it('rejects a mapping the core schema refuses with path: message lines', async () => {
    const err = await create({ mapping: { type: 'generic' } }).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 422, code: 'validation_failed' });
    expect((err as { detail: string }).detail).toMatch(/^body: /);
    await expect(create({ mapping: { ...mapping, extra: 1 } })).rejects.toMatchObject({
      status: 422,
    });
  });

  it('rejects an empty severity map key', async () => {
    await expect(
      create({ mapping: { ...mapping, severity: { map: { '': 'high' } } } }),
    ).rejects.toMatchObject({ status: 422, code: 'validation_failed' });
  });

  it('checks a literal type, but not a templated one', async () => {
    await expect(create({ mapping: { ...mapping, type: 'Bad Type' } })).rejects.toMatchObject({
      status: 422,
    });
    await expect(
      create({ mapping: { ...mapping, type: 'owlwire.internal' } }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      create({ mapping: { ...mapping, type: 'gh.{{headers.x-github-event}}' } }),
    ).resolves.toBeDefined();
    await expect(
      create({ mapping: { ...mapping, type: 'account.inactive' } }),
    ).resolves.toBeDefined();
  });

  it('limits the sample payload to 64 KiB of JSON', async () => {
    const fits = { s: 'x'.repeat(64 * 1024 - 8) };
    expect(Buffer.byteLength(JSON.stringify(fits))).toBe(64 * 1024);
    await expect(create({ samplePayload: fits })).resolves.toBeDefined();
    await expect(create({ samplePayload: { s: 'x'.repeat(64 * 1024 - 7) } })).rejects.toMatchObject(
      { status: 422, code: 'validation_failed' },
    );
  });

  it('rejects a duplicate key with 409', async () => {
    const key = nextKey();
    await create({ key });
    await expect(create({ key })).rejects.toMatchObject({ status: 409, code: 'conflict' });
    await expect(create({ key }, wsB, actorB)).resolves.toBeDefined();
  });

  it('validates on update and keeps the key', async () => {
    const row = await create();
    await expect(
      updateWorkspaceSourceTemplate(d, tenantScope(wsA), actorA, row.id, {
        mapping: { type: 'x' },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const updated = await updateWorkspaceSourceTemplate(d, tenantScope(wsA), actorA, row.id, {
      name: 'Renamed',
      mapping: { ...mapping, title: 'T' },
    });
    expect(updated).toMatchObject({ key: row.key, name: 'Renamed' });
    await expect(
      updateWorkspaceSourceTemplate(d, tenantScope(wsA), actorA, row.id, {
        samplePayload: { s: 'x'.repeat(64 * 1024) },
      }),
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe('not found and in use', () => {
  it('returns 404 for a missing template and for one of another workspace', async () => {
    const row = await create();
    const missing = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    await expect(
      updateWorkspaceSourceTemplate(d, tenantScope(wsA), actorA, missing, { name: 'x' }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(
      updateWorkspaceSourceTemplate(d, tenantScope(wsB), actorB, row.id, { name: 'x' }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(
      deleteWorkspaceSourceTemplate(d, tenantScope(wsB), actorB, row.id),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await expect(
      previewSourceTemplate(d, tenantScope(wsB), { templateId: row.id, payload: {} }),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
    await deleteWorkspaceSourceTemplate(d, tenantScope(wsA), actorA, row.id);
    await expect(
      deleteWorkspaceSourceTemplate(d, tenantScope(wsA), actorA, row.id),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses to delete a template an active installation uses', async () => {
    const row = await create();
    const { app } = await createWorkspaceApp(
      d,
      tenantScope(wsA),
      actorA,
      { name: 'Hooks', visibility: 'private' },
      { isInstanceAdmin: false },
    );
    await createWorkspaceInstallation(d, tenantScope(wsA), actorA, {
      appId: app.id,
      sourceTemplateId: row.id,
    });
    await expect(
      deleteWorkspaceSourceTemplate(d, tenantScope(wsA), actorA, row.id),
    ).rejects.toMatchObject({ status: 409, code: 'conflict' });
  });
});

describe('previewSourceTemplate', () => {
  it('renders an event from a mapping and from a stored template, writing nothing', async () => {
    const row = await create({ mapping: { ...mapping, title: 'Hello' } });
    const before = await auditCount();
    const fromMapping = await previewSourceTemplate(d, tenantScope(wsA), {
      mapping,
      payload: { text: 'hi' },
    });
    expect(fromMapping).toMatchObject({ ok: true, event: { type: 'generic', body: 'hi' } });
    const stored = await previewSourceTemplate(d, tenantScope(wsA), {
      templateId: row.id,
      payload: { text: 'hi' },
    });
    expect(stored).toMatchObject({ ok: true, event: { title: 'Hello', body: 'hi' } });
    expect(await auditCount()).toBe(before);
  });

  it('reports template errors by path', async () => {
    const r = await previewSourceTemplate(d, tenantScope(wsA), { mapping, payload: {} });
    expect(r).toEqual({ ok: false, errors: [{ path: 'body', message: 'body rendered empty' }] });
  });

  it('reports event input limit violations as errors', async () => {
    const r = await previewSourceTemplate(d, tenantScope(wsA), {
      mapping: { ...mapping, title: '{{payload.text}}' },
      payload: { text: 'x'.repeat(257) },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toContain('title');
  });

  it('filters the sample headers like ingestion does', async () => {
    const r = await previewSourceTemplate(d, tenantScope(wsA), {
      mapping: {
        type: 'gh.{{headers.x-github-event}}',
        body: 'b',
        title: '[{{headers.authorization}}]',
      },
      payload: {},
      headers: { 'X-GitHub-Event': 'push', Authorization: 'Bearer secret' },
    });
    expect(r).toMatchObject({ ok: true, event: { type: 'gh.push' } });
    if (r.ok) expect(r.event.title).toBe('[]');
  });

  it('rejects an invalid mapping with 422', async () => {
    await expect(
      previewSourceTemplate(d, tenantScope(wsA), { mapping: { type: 'x' }, payload: {} }),
    ).rejects.toMatchObject({ status: 422 });
  });
});
