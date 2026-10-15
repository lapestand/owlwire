import { isUuid, type WorkspaceRole } from '@owlwire/core';
import { and, asc, count, eq, inArray, isNull, or } from 'drizzle-orm';
import { mapPgErrors, RepoConflictError, RepoInputError } from '../errors.js';
import { authUser, memberships, workspaces } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';
import { type WorkspaceSummary, workspaceSummaryColumns } from './workspaces.js';

export interface MembershipRow {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  createdAt: Date;
}

export interface MembershipContext {
  role: WorkspaceRole;
  workspace: WorkspaceSummary;
}

export interface MemberListItem {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: WorkspaceRole;
  joinedAt: Date;
}

/**
 * `RepoConflictError.constraint` when a demotion or removal would leave the workspace without an owner. It is a reason
 * code, not a Postgres constraint name; the API maps it to a 409.
 */
export const LAST_OWNER = 'last_owner';

const USER_FK = 'memberships_user_id_auth_user_id_fk';
const WORKSPACE_FK = 'memberships_workspace_id_workspaces_id_fk';

const memberKey = (t: TenantTx, userId: string) =>
  and(eq(memberships.workspaceId, t.workspaceId), eq(memberships.userId, userId));

/**
 * Locks the membership of `userId` together with every owner membership of the workspace (FOR UPDATE, in user_id
 * order so that concurrent callers take the locks in the same order). A concurrent demotion or removal of another
 * owner waits here; once it commits, Postgres re-checks the locked rows, so the owner count read afterwards is current.
 *
 * Safe-side false conflict: a row that becomes an owner after this statement's snapshot (a concurrent transfer that
 * promotes someone else, or an uncommitted addMembership with role owner) is not counted. The check can then refuse
 * with LAST_OWNER although an owner would remain. It never lets the owner count reach zero; callers must treat the
 * 409 as possible (and may retry once).
 */
async function lockOwnersAnd(
  t: TenantTx,
  userId: string,
): Promise<{ target: { role: WorkspaceRole } | undefined; owners: number }> {
  const rows = await q(t)
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, t.workspaceId),
        or(eq(memberships.role, 'owner'), eq(memberships.userId, userId)),
      ),
    )
    .orderBy(asc(memberships.userId))
    .for('update');
  return {
    target: rows.find((r) => r.userId === userId),
    owners: rows.filter((r) => r.role === 'owner').length,
  };
}

/** A malformed user id answers null before any SQL. */
export async function getMembership(t: TenantTx, userId: string): Promise<MembershipRow | null> {
  if (!isUuid(userId)) return null;
  const rows = await q(t).select().from(memberships).where(memberKey(t, userId)).limit(1);
  return rows[0] ?? null;
}

/** The user's role together with the workspace; null for a soft-deleted workspace or a malformed id. */
export async function getMembershipContext(
  t: TenantTx,
  userId: string,
): Promise<MembershipContext | null> {
  if (!isUuid(userId)) return null;
  const rows = await q(t)
    .select({ role: memberships.role, workspace: workspaceSummaryColumns })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(
      and(memberKey(t, userId), eq(workspaces.id, t.workspaceId), isNull(workspaces.deletedAt)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listMembers(t: TenantTx): Promise<MemberListItem[]> {
  return q(t)
    .select({
      userId: memberships.userId,
      name: authUser.name,
      email: authUser.email,
      image: authUser.image,
      role: memberships.role,
      joinedAt: memberships.createdAt,
    })
    .from(memberships)
    .innerJoin(authUser, eq(authUser.id, memberships.userId))
    .where(eq(memberships.workspaceId, t.workspaceId))
    .orderBy(asc(memberships.createdAt), asc(authUser.email));
}

/**
 * Adds the user with the given role and writes member.added. Answers false (and writes nothing) when the user is
 * already a member. A malformed user id is RepoInputError before any SQL; an unknown user is RepoNotFoundError('user').
 *
 * Caller invariant: `userId` is the acting session user's own id (creating a workspace, accepting an invitation),
 * never an id taken from a client. Any instance user id is accepted here, and listMembers then shows that user's name
 * to the workspace and their email to its owners and admins, so an "add member by id" path would disclose other
 * users' emails.
 *
 * Like every membership mutator here, this does not check that the workspace is live. Callers run after the
 * workspace access check (getMembershipContext answers null for a soft-deleted workspace); to serialise against a
 * concurrent soft delete, take lockWorkspaceForUpdate first in the same transaction.
 */
export async function addMembership(
  t: TenantTx,
  input: { userId: string; role: WorkspaceRole; via?: 'create' | 'invitation' },
  actor: AuditActor,
): Promise<boolean> {
  if (!isUuid(input.userId)) throw new RepoInputError('membership', 'malformed user id');
  const rows = await mapPgErrors(
    'membership',
    input.userId,
    () =>
      q(t)
        .insert(memberships)
        .values({
          workspaceId: t.workspaceId,
          userId: input.userId,
          role: input.role,
          createdAt: now(t),
        })
        .onConflictDoNothing()
        .returning({ userId: memberships.userId }),
    {
      fkNotFound: {
        [USER_FK]: { entity: 'user', id: input.userId },
        [WORKSPACE_FK]: { entity: 'workspace', id: t.workspaceId },
      },
    },
  );
  if (rows.length === 0) return false;
  await writeAudit(t, {
    action: 'member.added',
    actor,
    targetType: 'member',
    targetId: input.userId,
    data: { role: input.role, ...(input.via ? { via: input.via } : {}) },
  });
  return true;
}

/**
 * Changes a member's role and writes member.role_changed. Answers false for a non-member or a malformed id, true
 * without an audit row when the role is already the requested one. Demoting the last owner is
 * RepoConflictError('membership', LAST_OWNER); the owner count is read under a row lock (see lockOwnersAnd), so two
 * concurrent demotions cannot both succeed. Under a concurrent promotion the refusal can be a false conflict (see
 * lockOwnersAnd). Does not check that the workspace is live (see addMembership).
 */
export async function updateMemberRole(
  t: TenantTx,
  userId: string,
  role: WorkspaceRole,
  actor: AuditActor,
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const { target, owners } = await lockOwnersAnd(t, userId);
  if (!target) return false;
  if (target.role === role) return true;
  if (target.role === 'owner' && owners <= 1) throw new RepoConflictError('membership', LAST_OWNER);
  await mapPgErrors('membership', userId, () =>
    q(t).update(memberships).set({ role }).where(memberKey(t, userId)),
  );
  await writeAudit(t, {
    action: 'member.role_changed',
    actor,
    targetType: 'member',
    targetId: userId,
    data: { from: target.role, to: role },
  });
  return true;
}

/**
 * Removes a member and writes member.removed (`self` when the actor removed themselves). Answers false for a
 * non-member or a malformed id. Removing the last owner is RepoConflictError('membership', LAST_OWNER), decided
 * under the same row lock as updateMemberRole (including its safe-side false conflict). Does not check that the
 * workspace is live (see addMembership).
 */
export async function removeMembership(
  t: TenantTx,
  userId: string,
  actor: AuditActor,
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const { target, owners } = await lockOwnersAnd(t, userId);
  if (!target) return false;
  if (target.role === 'owner' && owners <= 1) throw new RepoConflictError('membership', LAST_OWNER);
  await mapPgErrors('membership', userId, () =>
    q(t).delete(memberships).where(memberKey(t, userId)),
  );
  await writeAudit(t, {
    action: 'member.removed',
    actor,
    targetType: 'member',
    targetId: userId,
    data: { role: target.role, self: actor.kind === 'user' && actor.userId === userId },
  });
  return true;
}

/**
 * Number of owners right now, without a lock. A decision that must hold until commit (the last-owner rule) is made by
 * updateMemberRole and removeMembership themselves, under a row lock.
 */
export async function countOwners(t: TenantTx): Promise<number> {
  const rows = await q(t)
    .select({ n: count() })
    .from(memberships)
    .where(and(eq(memberships.workspaceId, t.workspaceId), eq(memberships.role, 'owner')));
  return rows[0]?.n ?? 0;
}

/**
 * `to` becomes owner and `from` steps down to admin, with one workspace-level audit entry
 * (workspace.ownership_transferred). Answers false and writes nothing when either user is not a member of this
 * workspace, when `from` is not an owner, or when an id is malformed (checked before any SQL). The same user on both
 * sides is RepoInputError: it would demote the only owner. Both rows are locked first, in user_id order. Does not
 * check that the workspace is live (see addMembership).
 */
export async function transferWorkspaceOwnership(
  t: TenantTx,
  input: { from: string; to: string },
  actor: AuditActor,
): Promise<boolean> {
  if (!isUuid(input.from) || !isUuid(input.to)) return false;
  if (input.from === input.to) {
    throw new RepoInputError('membership', 'ownership transfer needs two different users');
  }
  const rows = await q(t)
    .select({ userId: memberships.userId, role: memberships.role })
    .from(memberships)
    .where(
      and(
        eq(memberships.workspaceId, t.workspaceId),
        inArray(memberships.userId, [input.from, input.to]),
      ),
    )
    .orderBy(asc(memberships.userId))
    .for('update');
  const from = rows.find((r) => r.userId === input.from);
  const to = rows.find((r) => r.userId === input.to);
  if (!from || !to || from.role !== 'owner') return false;
  await mapPgErrors('membership', input.to, async () => {
    await q(t).update(memberships).set({ role: 'owner' }).where(memberKey(t, input.to));
    await q(t).update(memberships).set({ role: 'admin' }).where(memberKey(t, input.from));
  });
  await writeAudit(t, {
    action: 'workspace.ownership_transferred',
    actor,
    targetType: 'workspace',
    targetId: t.workspaceId,
    data: { from: input.from, to: input.to },
  });
  return true;
}
