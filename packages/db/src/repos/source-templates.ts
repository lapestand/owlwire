import { isUuid, newId, type SourceTemplateMapping } from '@owlwire/core';
import { and, asc, eq } from 'drizzle-orm';
import { mapPgErrors, RepoConflictError } from '../errors.js';
import { installations, sourceTemplates } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';

export type SourceTemplateRow = typeof sourceTemplates.$inferSelect;

export interface CreateSourceTemplateInput {
  key: string;
  name: string;
  description?: string;
  mapping: SourceTemplateMapping;
  samplePayload?: unknown;
}

/** The key never changes after creation. */
export type UpdateSourceTemplateInput = Partial<{
  name: string;
  description: string;
  mapping: SourceTemplateMapping;
  samplePayload: unknown;
}>;

const byId = (t: TenantTx, id: string) =>
  and(eq(sourceTemplates.workspaceId, t.workspaceId), eq(sourceTemplates.id, id));

/** Rows created here are always user templates; the origin of bundled templates is set elsewhere. */
export async function createSourceTemplate(
  t: TenantTx,
  input: CreateSourceTemplateInput,
  actor: AuditActor,
): Promise<SourceTemplateRow> {
  const id = newId();
  const at = now(t);
  const rows = await mapPgErrors('source_template', id, () =>
    q(t)
      .insert(sourceTemplates)
      .values({
        id,
        workspaceId: t.workspaceId,
        key: input.key,
        name: input.name,
        description: input.description ?? '',
        mapping: input.mapping,
        samplePayload: input.samplePayload ?? null,
        origin: 'user',
        createdAt: at,
        updatedAt: at,
      })
      .returning(),
  );
  const row = rows[0];
  if (!row) throw new Error('source template insert returned no row');
  await writeAudit(t, {
    action: 'source_template.created',
    actor,
    targetType: 'source_template',
    targetId: id,
    data: { key: input.key },
  });
  return row;
}

export async function getSourceTemplate(
  t: TenantTx,
  id: string,
): Promise<SourceTemplateRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q(t).select().from(sourceTemplates).where(byId(t, id));
  return rows[0] ?? null;
}

export async function listSourceTemplates(t: TenantTx): Promise<SourceTemplateRow[]> {
  return q(t)
    .select()
    .from(sourceTemplates)
    .where(eq(sourceTemplates.workspaceId, t.workspaceId))
    .orderBy(asc(sourceTemplates.key), asc(sourceTemplates.id));
}

/**
 * Returns null when this workspace has no such template. The audit row names the changed fields only, never the
 * mapping itself. An empty patch changes nothing and writes no audit row.
 */
export async function updateSourceTemplate(
  t: TenantTx,
  id: string,
  patch: UpdateSourceTemplateInput,
  actor: AuditActor,
): Promise<SourceTemplateRow | null> {
  if (!isUuid(id)) return null;
  const set: Partial<typeof sourceTemplates.$inferInsert> = {};
  const fields: string[] = [];
  if (patch.name !== undefined) {
    set.name = patch.name;
    fields.push('name');
  }
  if (patch.description !== undefined) {
    set.description = patch.description;
    fields.push('description');
  }
  if (patch.mapping !== undefined) {
    set.mapping = patch.mapping;
    fields.push('mapping');
  }
  if (patch.samplePayload !== undefined) {
    set.samplePayload = patch.samplePayload;
    fields.push('samplePayload');
  }
  if (fields.length === 0) return getSourceTemplate(t, id);
  const rows = await q(t)
    .update(sourceTemplates)
    .set({ ...set, updatedAt: now(t) })
    .where(byId(t, id))
    .returning();
  const row = rows[0];
  if (!row) return null;
  await writeAudit(t, {
    action: 'source_template.updated',
    actor,
    targetType: 'source_template',
    targetId: id,
    data: { key: row.key, fields },
  });
  return row;
}

/**
 * Clears the link on revoked installations, then deletes. A template an active installation still uses stays and
 * raises `RepoConflictError`; the template row is locked, so no installation can bind to it between the check and
 * the delete (and the `on delete restrict` foreign key backs the check up). Returns false when this workspace has no such template.
 */
export async function deleteSourceTemplate(
  t: TenantTx,
  id: string,
  actor: AuditActor,
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const existing = await q(t)
    .select({ key: sourceTemplates.key })
    .from(sourceTemplates)
    .where(byId(t, id))
    .for('update');
  const key = existing[0]?.key;
  if (key === undefined) return false;
  await q(t)
    .update(installations)
    .set({ sourceTemplateId: null })
    .where(
      and(
        eq(installations.workspaceId, t.workspaceId),
        eq(installations.sourceTemplateId, id),
        eq(installations.status, 'revoked'),
      ),
    );
  const users = await q(t)
    .select({ id: installations.id })
    .from(installations)
    .where(
      and(eq(installations.workspaceId, t.workspaceId), eq(installations.sourceTemplateId, id)),
    )
    .limit(1);
  if (users.length > 0) {
    throw new RepoConflictError('source_template', 'installations_source_template_ws_fk');
  }
  await q(t).delete(sourceTemplates).where(byId(t, id));
  await writeAudit(t, {
    action: 'source_template.deleted',
    actor,
    targetType: 'source_template',
    targetId: id,
    data: { key },
  });
  return true;
}
