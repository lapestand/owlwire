import { isUuid } from '@owlwire/core';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { q } from '../repos/context.js';
import type { MembershipContext } from '../repos/memberships.js';
import { type WorkspaceSummary, workspaceSummaryColumns } from '../repos/workspaces.js';
import { memberships, workspaces } from '../schema/index.js';
import type { SystemTx } from '../scope.js';

/**
 * Every live workspace the user belongs to, with the user's role, oldest workspace first. Soft-deleted workspaces are
 * left out; a malformed id answers an empty list before any SQL.
 */
export async function listMembershipsForUser(
  s: SystemTx,
  userId: string,
): Promise<MembershipContext[]> {
  if (!isUuid(userId)) return [];
  return q(s)
    .select({ role: memberships.role, workspace: workspaceSummaryColumns })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(and(eq(memberships.userId, userId), isNull(workspaces.deletedAt)))
    .orderBy(asc(workspaces.createdAt), asc(workspaces.id));
}

/** The user's live personal workspace (at most one, enforced by a unique index); null for a malformed id. */
export async function findPersonalWorkspaceByOwner(
  s: SystemTx,
  userId: string,
): Promise<WorkspaceSummary | null> {
  if (!isUuid(userId)) return null;
  const rows = await q(s)
    .select(workspaceSummaryColumns)
    .from(workspaces)
    .where(
      and(
        eq(workspaces.ownerUserId, userId),
        eq(workspaces.kind, 'personal'),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}
