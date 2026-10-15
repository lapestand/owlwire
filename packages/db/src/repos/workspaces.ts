import { isUuid } from '@owlwire/core';
import { and, eq, isNull } from 'drizzle-orm';
import { mapPgErrors, RepoInputError } from '../errors.js';
import { workspaces } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';
import { insertWorkspaceKey } from './workspace-keys.js';

export type WorkspaceRow = typeof workspaces.$inferSelect;

const OWNER_FK = 'workspaces_owner_user_id_auth_user_id_fk';

/**
 * `RepoConflictError.constraint` when a workspace slug is already taken. Slugs stay taken after a soft delete, so a
 * deleted workspace's slug also conflicts.
 */
export const WORKSPACE_SLUG_UNIQUE = 'workspaces_slug_unique';

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  kind: 'personal' | 'community';
  /** Only a personal workspace has an owner column; community owners live in memberships. */
  ownerUserId?: string | null;
}

/**
 * Workspace kimliği t.workspaceId'dir; çağıran newId() ile sunucuda üretip withTenant'a verir, istemci
 * girdisinden almaz. Workspace, DEK'i ve denetim kaydı aynı transaction'da yazılır. Yinelenen slug
 * RepoConflictError.
 *
 * `ownerUserId` is only accepted on a personal workspace (RepoInputError otherwise, and for a malformed id, before any
 * SQL). An unknown owner is RepoNotFoundError('user'); a second live personal workspace for the same owner is
 * RepoConflictError (`workspaces_personal_owner_uidx`).
 */
export async function createWorkspace(
  t: TenantTx,
  input: CreateWorkspaceInput,
  actor: AuditActor,
): Promise<WorkspaceRow> {
  const ownerUserId = input.ownerUserId ?? null;
  if (ownerUserId !== null) {
    if (!isUuid(ownerUserId)) throw new RepoInputError('workspace', 'malformed owner user id');
    if (input.kind !== 'personal') {
      throw new RepoInputError('workspace', 'only a personal workspace has an owner user');
    }
  }
  const rows = await mapPgErrors(
    'workspace',
    t.workspaceId,
    () =>
      q(t)
        .insert(workspaces)
        .values({
          id: t.workspaceId,
          name: input.name,
          slug: input.slug,
          kind: input.kind,
          ownerUserId,
          createdAt: now(t),
        })
        .returning(),
    { fkNotFound: { [OWNER_FK]: { entity: 'user', id: ownerUserId ?? '' } } },
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

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  kind: 'personal' | 'community';
  ownerUserId: string | null;
  createdAt: Date;
}

/** Package internal: the columns of a WorkspaceSummary, shared by the tenant and system queries. */
export const workspaceSummaryColumns = {
  id: workspaces.id,
  name: workspaces.name,
  slug: workspaces.slug,
  kind: workspaces.kind,
  ownerUserId: workspaces.ownerUserId,
  createdAt: workspaces.createdAt,
};

export function toWorkspaceSummary(row: WorkspaceRow): WorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    ownerUserId: row.ownerUserId,
    createdAt: row.createdAt,
  };
}

const liveWorkspace = (t: TenantTx) =>
  and(eq(workspaces.id, t.workspaceId), isNull(workspaces.deletedAt));

/**
 * SELECT ... FOR UPDATE on the scope's workspace row: serializes concurrent changes to the same workspace (settings,
 * deletion, membership decisions) until the transaction ends. A soft-deleted workspace answers null.
 */
export async function lockWorkspaceForUpdate(t: TenantTx): Promise<WorkspaceSummary | null> {
  const rows = await q(t)
    .select(workspaceSummaryColumns)
    .from(workspaces)
    .where(liveWorkspace(t))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/**
 * Renames the scope's workspace and/or changes its slug; writes workspace.updated with the changed fields. A taken
 * slug is RepoConflictError. A soft-deleted workspace answers null. A patch without fields changes nothing, writes no
 * audit row and answers the current summary.
 */
export async function updateWorkspace(
  t: TenantTx,
  patch: { name?: string; slug?: string },
  actor: AuditActor,
): Promise<WorkspaceSummary | null> {
  const set: { name?: string; slug?: string } = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.slug !== undefined) set.slug = patch.slug;
  if (Object.keys(set).length === 0) {
    const rows = await q(t)
      .select(workspaceSummaryColumns)
      .from(workspaces)
      .where(liveWorkspace(t));
    return rows[0] ?? null;
  }
  const rows = await mapPgErrors('workspace', t.workspaceId, () =>
    q(t).update(workspaces).set(set).where(liveWorkspace(t)).returning(workspaceSummaryColumns),
  );
  const row = rows[0];
  if (!row) return null;
  await writeAudit(t, {
    action: 'workspace.updated',
    actor,
    targetType: 'workspace',
    targetId: t.workspaceId,
    data: { ...set },
  });
  return row;
}

/**
 * Marks the scope's workspace deleted and writes workspace.deleted; every later tenant lookup treats it as missing.
 * Answers false (and writes nothing) when it is already deleted. The rows of the workspace stay; purging them is not
 * part of this function.
 */
export async function softDeleteWorkspace(t: TenantTx, actor: AuditActor): Promise<boolean> {
  const rows = await mapPgErrors('workspace', t.workspaceId, () =>
    q(t)
      .update(workspaces)
      .set({ deletedAt: now(t) })
      .where(liveWorkspace(t))
      .returning({ id: workspaces.id }),
  );
  if (rows.length === 0) return false;
  await writeAudit(t, {
    action: 'workspace.deleted',
    actor,
    targetType: 'workspace',
    targetId: t.workspaceId,
  });
  return true;
}
