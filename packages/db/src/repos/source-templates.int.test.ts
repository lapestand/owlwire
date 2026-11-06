import { newId, type SourceTemplateMapping } from '@owlwire/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { pgErrorCode, RepoConflictError, RepoNotFoundError } from '../errors.js';
import { type TenantTx, tenantScope, withTenant } from '../scope.js';
import { createApp } from './apps.js';
import { listAuditLog, SYSTEM_ACTOR } from './audit.js';
import {
  createInstallation,
  getInstallation,
  revokeInstallation,
  setInstallationSourceTemplate,
} from './installations.js';
import {
  createSourceTemplate,
  deleteSourceTemplate,
  getSourceTemplate,
  listSourceTemplates,
  updateSourceTemplate,
} from './source-templates.js';

let env: DbTestEnv;
let A: string;
let B: string;

const inWs =
  (ws: string) =>
  <T>(fn: (t: TenantTx) => Promise<T>) =>
    withTenant(env.db, tenantScope(ws), fn);

const mapping: SourceTemplateMapping = { type: 'generic', body: '{{payload.message}}' };

beforeAll(async () => {
  env = await setupDbTestEnv();
  A = await createTestWorkspace(env.db, 'alpha');
  B = await createTestWorkspace(env.db, 'bravo');
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

const uniqueKey = (label: string) => `${label}-${newId().slice(-12)}`;

async function newInstallation(ws: string, sourceTemplateId?: string | null) {
  return inWs(ws)(async (t) => {
    const app = await createApp(
      t,
      { name: 'Hook app', slug: `hook-${newId().slice(-12)}`, visibility: 'private' },
      SYSTEM_ACTOR,
    );
    return createInstallation(
      t,
      {
        appId: app.id,
        tokenHash: newId(),
        tokenPrefix: 'ow_inst_test',
        sourceTemplateId,
      },
      SYSTEM_ACTOR,
    );
  });
}

describe('source templates repo', () => {
  it('creates, reads, lists, updates and deletes a template with audit rows', async () => {
    const key = uniqueKey('crud');
    const created = await inWs(A)((t) =>
      createSourceTemplate(
        t,
        { key, name: 'Crud', mapping, samplePayload: { message: 'hi' } },
        SYSTEM_ACTOR,
      ),
    );
    expect(created).toMatchObject({
      key,
      name: 'Crud',
      description: '',
      origin: 'user',
      originRef: null,
      workspaceId: A,
      mapping,
      samplePayload: { message: 'hi' },
    });
    expect(await inWs(A)((t) => getSourceTemplate(t, created.id))).toEqual(created);
    const listed = await inWs(A)((t) => listSourceTemplates(t));
    expect(listed.map((r) => r.key)).toEqual([...listed.map((r) => r.key)].sort());
    expect(listed.map((r) => r.id)).toContain(created.id);

    env.clock.advance(1000);
    const newMapping: SourceTemplateMapping = { type: 'generic', body: 'changed' };
    const updated = await inWs(A)((t) =>
      updateSourceTemplate(t, created.id, { name: 'Renamed', mapping: newMapping }, SYSTEM_ACTOR),
    );
    expect(updated).toMatchObject({ key, name: 'Renamed', mapping: newMapping });
    expect(updated?.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());

    expect(await inWs(A)((t) => deleteSourceTemplate(t, created.id, SYSTEM_ACTOR))).toBe(true);
    expect(await inWs(A)((t) => getSourceTemplate(t, created.id))).toBeNull();
    expect(await inWs(A)((t) => deleteSourceTemplate(t, created.id, SYSTEM_ACTOR))).toBe(false);

    const audit = (await inWs(A)((t) => listAuditLog(t, { limit: 200 }))).filter(
      (e) => e.targetId === created.id,
    );
    const byAction = Object.fromEntries(audit.map((e) => [e.action, e.data]));
    expect(byAction['source_template.created']).toEqual({ key });
    expect(byAction['source_template.updated']).toEqual({ key, fields: ['name', 'mapping'] });
    expect(byAction['source_template.deleted']).toEqual({ key });
    expect(audit.every((e) => e.targetType === 'source_template')).toBe(true);
  });

  it('rejects a duplicate key within a workspace but allows it in another', async () => {
    const key = uniqueKey('dup');
    await inWs(A)((t) => createSourceTemplate(t, { key, name: 'One', mapping }, SYSTEM_ACTOR));
    await expect(
      inWs(A)((t) => createSourceTemplate(t, { key, name: 'Two', mapping }, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoConflictError);
    await expect(
      inWs(B)((t) => createSourceTemplate(t, { key, name: 'Three', mapping }, SYSTEM_ACTOR)),
    ).resolves.toMatchObject({ key });
  });

  it('binds a template to an active installation and unbinds it', async () => {
    const tpl = await inWs(A)((t) =>
      createSourceTemplate(t, { key: uniqueKey('bind'), name: 'Bind', mapping }, SYSTEM_ACTOR),
    );
    const inst = await newInstallation(A);
    const bound = await inWs(A)((t) =>
      setInstallationSourceTemplate(t, inst.id, tpl.id, SYSTEM_ACTOR),
    );
    expect(bound).toMatchObject({ id: inst.id, sourceTemplateId: tpl.id });
    const audit = (await inWs(A)((t) => listAuditLog(t, { limit: 1 })))[0];
    expect(audit).toMatchObject({
      action: 'installation.updated',
      targetId: inst.id,
      data: { sourceTemplateId: tpl.id },
    });
    const unbound = await inWs(A)((t) =>
      setInstallationSourceTemplate(t, inst.id, null, SYSTEM_ACTOR),
    );
    expect(unbound?.sourceTemplateId).toBeNull();
  });

  it('records the template on installation creation', async () => {
    const tpl = await inWs(A)((t) =>
      createSourceTemplate(t, { key: uniqueKey('create'), name: 'C', mapping }, SYSTEM_ACTOR),
    );
    const inst = await newInstallation(A, tpl.id);
    expect(inst.sourceTemplateId).toBe(tpl.id);
    const created = (await inWs(A)((t) => listAuditLog(t, { limit: 200 }))).find(
      (e) => e.action === 'installation.created' && e.targetId === inst.id,
    );
    expect(created?.data).toMatchObject({ sourceTemplateId: tpl.id });
  });

  it('refuses to bind a revoked or unknown installation', async () => {
    const tpl = await inWs(A)((t) =>
      createSourceTemplate(t, { key: uniqueKey('rev'), name: 'R', mapping }, SYSTEM_ACTOR),
    );
    const inst = await newInstallation(A);
    await inWs(A)((t) => revokeInstallation(t, inst.id, SYSTEM_ACTOR));
    expect(
      await inWs(A)((t) => setInstallationSourceTemplate(t, inst.id, tpl.id, SYSTEM_ACTOR)),
    ).toBeNull();
    expect(
      await inWs(A)((t) => setInstallationSourceTemplate(t, newId(), tpl.id, SYSTEM_ACTOR)),
    ).toBeNull();
  });

  it('refuses to delete a template an active installation uses', async () => {
    const tpl = await inWs(A)((t) =>
      createSourceTemplate(t, { key: uniqueKey('used'), name: 'U', mapping }, SYSTEM_ACTOR),
    );
    await newInstallation(A, tpl.id);
    await expect(
      inWs(A)((t) => deleteSourceTemplate(t, tpl.id, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoConflictError);
    expect(await inWs(A)((t) => getSourceTemplate(t, tpl.id))).not.toBeNull();
  });

  it('deletes a template used only by a revoked installation and clears the link', async () => {
    const tpl = await inWs(A)((t) =>
      createSourceTemplate(t, { key: uniqueKey('gone'), name: 'G', mapping }, SYSTEM_ACTOR),
    );
    const inst = await newInstallation(A, tpl.id);
    await inWs(A)((t) => revokeInstallation(t, inst.id, SYSTEM_ACTOR));
    expect(await inWs(A)((t) => deleteSourceTemplate(t, tpl.id, SYSTEM_ACTOR))).toBe(true);
    expect((await inWs(A)((t) => getInstallation(t, inst.id)))?.sourceTemplateId).toBeNull();
  });

  it('rejects a template from another workspace', async () => {
    const foreign = await inWs(B)((t) =>
      createSourceTemplate(t, { key: uniqueKey('foreign'), name: 'F', mapping }, SYSTEM_ACTOR),
    );
    const inst = await newInstallation(A);
    await expect(
      inWs(A)((t) => setInstallationSourceTemplate(t, inst.id, foreign.id, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(newInstallation(A, foreign.id)).rejects.toBeInstanceOf(RepoNotFoundError);
    // The composite foreign key refuses it below the repository too (owner pool, RLS bypassed).
    const err = await env.owner
      .query('update installations set source_template_id = $1 where id = $2', [
        foreign.id,
        inst.id,
      ])
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(pgErrorCode(err)).toBe('23503');
  });

  it('keeps another workspace invisible', async () => {
    const tpl = await inWs(B)((t) =>
      createSourceTemplate(t, { key: uniqueKey('other'), name: 'O', mapping }, SYSTEM_ACTOR),
    );
    expect(await inWs(A)((t) => getSourceTemplate(t, tpl.id))).toBeNull();
    expect((await inWs(A)((t) => listSourceTemplates(t))).map((r) => r.id)).not.toContain(tpl.id);
    expect(
      await inWs(A)((t) => updateSourceTemplate(t, tpl.id, { name: 'x' }, SYSTEM_ACTOR)),
    ).toBeNull();
    expect(await inWs(A)((t) => deleteSourceTemplate(t, tpl.id, SYSTEM_ACTOR))).toBe(false);
    expect(await inWs(B)((t) => getSourceTemplate(t, tpl.id))).toMatchObject({ name: 'O' });
  });
});
