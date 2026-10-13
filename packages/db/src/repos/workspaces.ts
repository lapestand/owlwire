import { eq } from 'drizzle-orm';
import { mapPgErrors } from '../errors.js';
import { workspaces } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';
import { insertWorkspaceKey } from './workspace-keys.js';

export type WorkspaceRow = typeof workspaces.$inferSelect;

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  kind: 'personal' | 'community';
}

/**
 * Workspace kimliği t.workspaceId'dir; çağıran newId() ile sunucuda üretip withTenant'a verir, istemci
 * girdisinden almaz. Workspace, DEK'i ve denetim kaydı aynı transaction'da yazılır. Yinelenen slug
 * RepoConflictError.
 */
export async function createWorkspace(
  t: TenantTx,
  input: CreateWorkspaceInput,
  actor: AuditActor,
): Promise<WorkspaceRow> {
  const rows = await mapPgErrors('workspace', t.workspaceId, () =>
    q(t)
      .insert(workspaces)
      .values({
        id: t.workspaceId,
        name: input.name,
        slug: input.slug,
        kind: input.kind,
        createdAt: now(t),
      })
      .returning(),
  );
  const row = rows[0];
  if (!row) throw new Error('workspace insert returned no row');
  await insertWorkspaceKey(t);
  await writeAudit(t, {
    action: 'workspace.created',
    actor,
    targetType: 'workspace',
    targetId: t.workspaceId,
    data: { slug: input.slug, kind: input.kind },
  });
  return row;
}

export async function getWorkspace(t: TenantTx): Promise<WorkspaceRow | null> {
  const rows = await q(t).select().from(workspaces).where(eq(workspaces.id, t.workspaceId));
  return rows[0] ?? null;
}
