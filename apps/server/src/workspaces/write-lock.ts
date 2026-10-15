import { roleAtLeast, type WorkspaceRole } from '@owlwire/core';
import {
  getMembership,
  lockWorkspaceForUpdate,
  type TenantTx,
  type WorkspaceSummary,
} from '@owlwire/db';
import { ProblemError } from '../http/problem.js';
import { notFound } from '../http/routes/api/problems.js';

/**
 * First step of every workspace write that depends on the caller's role. The access middleware checks the role in
 * its own transaction, so a demotion or removal can commit between that check and the write. This takes the
 * workspace row lock (FOR NO KEY UPDATE), which every such write takes first, and only then reads the caller's
 * membership again: concurrent writes run one after another, and each decides on the roles the previous one left
 * behind. Inserts that only reference the workspace (audit entries, memberships) are not blocked by this lock.
 *
 * A workspace deleted meanwhile, or a caller no longer a member, is the uniform 404; a role below `min` is 403.
 */
export async function lockForActor(
  t: TenantTx,
  actorUserId: string,
  min: WorkspaceRole = 'member',
): Promise<{ workspace: WorkspaceSummary; role: WorkspaceRole }> {
  const workspace = await lockWorkspaceForUpdate(t);
  if (!workspace) throw notFound();
  const membership = await getMembership(t, actorUserId);
  if (!membership) throw notFound();
  if (!roleAtLeast(membership.role, min)) throw new ProblemError(403, 'forbidden');
  return { workspace, role: membership.role };
}
