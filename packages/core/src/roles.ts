export const WORKSPACE_ROLES = ['owner', 'admin', 'member'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export const INVITABLE_ROLES = ['admin', 'member'] as const;
export type InvitableRole = (typeof INVITABLE_ROLES)[number];

const RANK: Record<WorkspaceRole, number> = { member: 0, admin: 1, owner: 2 };

export function roleAtLeast(actual: WorkspaceRole, required: WorkspaceRole): boolean {
  return RANK[actual] >= RANK[required];
}

type DenyReason = 'forbidden' | 'last_owner' | 'personal_workspace';
export type MemberDecision = { ok: true } | { ok: false; reason: DenyReason };

const allow: MemberDecision = { ok: true };
const deny = (reason: DenyReason): MemberDecision => ({ ok: false, reason });

export interface RoleChangeInput {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
  newRole: WorkspaceRole;
  ownerCount: number;
  personal: boolean;
}

/**
 * Only an owner touches an owner role; admins change admin and member roles. A change to the role the target already
 * has (a no-op) needs the same permission, but is never refused for the personal workspace or the last owner, since
 * nothing changes.
 */
export function canChangeRole(i: RoleChangeInput): MemberDecision {
  const touchesOwner = i.targetRole === 'owner' || i.newRole === 'owner';
  const noop = i.targetRole === i.newRole;
  if (i.personal && touchesOwner && !noop) return deny('personal_workspace');
  const permitted = touchesOwner ? i.actorRole === 'owner' : roleAtLeast(i.actorRole, 'admin');
  if (!permitted) return deny('forbidden');
  if (noop) return allow;
  if (i.targetRole === 'owner' && i.newRole !== 'owner' && i.ownerCount <= 1)
    return deny('last_owner');
  return allow;
}

export interface RemoveMemberInput {
  actorRole: WorkspaceRole;
  targetRole: WorkspaceRole;
  isSelf: boolean;
  ownerCount: number;
  targetIsPersonalOwner: boolean;
}

export function canRemoveMember(i: RemoveMemberInput): MemberDecision {
  if (i.targetIsPersonalOwner) return deny('personal_workspace');
  const lastOwner = i.targetRole === 'owner' && i.ownerCount <= 1;
  if (i.isSelf || i.actorRole === 'owner') return lastOwner ? deny('last_owner') : allow;
  if (i.actorRole === 'admin' && i.targetRole === 'member') return allow;
  return deny('forbidden');
}
