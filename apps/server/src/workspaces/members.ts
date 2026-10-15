import { canChangeRole, canRemoveMember, type WorkspaceRole } from '@owlwire/core';
import {
  type AuditActor,
  countOwners,
  getMembership,
  listMembers,
  type MemberListItem,
  removeMembership,
  tenantScope,
  transferWorkspaceOwnership,
  updateMemberRole,
  withTenant,
} from '@owlwire/db';
import type { BaseDeps } from '../base-deps.js';
import { ProblemError } from '../http/problem.js';
import { decisionProblem, notFound } from '../http/routes/api/problems.js';
import { lockForActor } from './write-lock.js';

/** Fixed detail of the 422 for a transfer to the caller themselves. */
const TARGET_IS_SELF = 'target_is_self';

/** Fixed detail of the 409 for a transfer to a user who already owns the workspace. */
const ALREADY_OWNER = 'already_owner';

const userActor = (userId: string): AuditActor => ({ kind: 'user', userId });

/** Every member with the name and email the workspace may see (the column-granted auth_user fields only). */
export function listWorkspaceMembers(
  deps: Pick<BaseDeps, 'db'>,
  workspaceId: string,
  filter?: { userIds?: readonly string[] },
): Promise<MemberListItem[]> {
  return withTenant(deps.db, tenantScope(workspaceId), (t) => listMembers(t, filter));
}

/**
 * Sets the target's role, decided by canChangeRole on the roles read under the workspace lock (see lockForActor).
 *
 * A change to the role the target already has is answered like the change itself: the same permission is needed
 * (403 otherwise; 409 personal_workspace for the personal owner), and an allowed one answers 200 with the member and
 * writes no audit entry. An admin may demote a peer admin or themselves; only an owner touches owner roles; the last
 * owner cannot be demoted (409 last_owner). A target who is not a member is 404.
 */
export async function changeMemberRole(
  deps: Pick<BaseDeps, 'db'>,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
  newRole: WorkspaceRole,
): Promise<MemberListItem> {
  return withTenant(deps.db, tenantScope(workspaceId), async (t) => {
    const { workspace, role: actorRole } = await lockForActor(t, actorUserId);
    const target = await getMembership(t, targetUserId);
    if (!target) throw notFound();
    const decision = canChangeRole({
      actorRole,
      targetRole: target.role,
      newRole,
      ownerCount: await countOwners(t),
      personal: workspace.kind === 'personal',
    });
    if (!decision.ok) throw decisionProblem(decision);
    // The repository re-checks the last owner under its own row lock and raises LAST_OWNER (409) itself.
    if (!(await updateMemberRole(t, targetUserId, newRole, userActor(actorUserId))))
      throw notFound();
    const [item] = await listMembers(t, { userIds: [targetUserId] });
    if (!item) throw notFound();
    return item;
  });
}

/**
 * Removes the target, or lets the caller leave when the target is the caller (decided by canRemoveMember under the
 * workspace lock). The owner of a personal workspace cannot leave it (409 personal_workspace); the last owner of a
 * community workspace cannot leave or be removed (409 last_owner).
 */
export async function removeMember(
  deps: Pick<BaseDeps, 'db'>,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  await withTenant(deps.db, tenantScope(workspaceId), async (t) => {
    const { workspace, role: actorRole } = await lockForActor(t, actorUserId);
    const target = await getMembership(t, targetUserId);
    if (!target) throw notFound();
    const decision = canRemoveMember({
      actorRole,
      targetRole: target.role,
      isSelf: actorUserId === targetUserId,
      ownerCount: await countOwners(t),
      targetIsPersonalOwner:
        workspace.kind === 'personal' && workspace.ownerUserId === targetUserId,
    });
    if (!decision.ok) throw decisionProblem(decision);
    if (!(await removeMembership(t, targetUserId, userActor(actorUserId)))) throw notFound();
  });
}

/**
 * Makes the target an owner and the caller an admin, in one transaction with one workspace.ownership_transferred
 * entry. Only an owner may transfer (403); a personal workspace cannot be transferred (409 personal_workspace); the
 * caller as target is 422 target_is_self; a target who is already an owner is 409 already_owner (the caller would
 * otherwise step down for nothing); a target who is not a member is 404.
 */
export async function transferOwnership(
  deps: Pick<BaseDeps, 'db'>,
  workspaceId: string,
  actorUserId: string,
  targetUserId: string,
): Promise<void> {
  await withTenant(deps.db, tenantScope(workspaceId), async (t) => {
    const { workspace } = await lockForActor(t, actorUserId, 'owner');
    if (workspace.kind === 'personal')
      throw new ProblemError(409, 'conflict', 'personal_workspace');
    if (actorUserId === targetUserId) {
      throw new ProblemError(422, 'validation_failed', TARGET_IS_SELF);
    }
    const target = await getMembership(t, targetUserId);
    if (!target) throw notFound();
    if (target.role === 'owner') throw new ProblemError(409, 'conflict', ALREADY_OWNER);
    const moved = await transferWorkspaceOwnership(
      t,
      { from: actorUserId, to: targetUserId },
      userActor(actorUserId),
    );
    if (!moved) throw notFound();
  });
}
