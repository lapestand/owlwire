import type { InvitableRole, WorkspaceRole } from '@owlwire/core';
import {
  addMembership,
  getInvitationForUpdate,
  getMembership,
  lockWorkspaceForUpdate,
  markInvitationAccepted,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { findInvitationByTokenHash, SYSTEM, withSystem } from '@owlwire/db/system';
import type { Deps } from '../deps.js';
import type { SessionUser } from '../http/middleware/session-auth.js';
import { ProblemError } from '../http/problem.js';
import { notFound } from '../http/routes/api/problems.js';
import { hashInvitationToken } from '../workspaces/invitation-token.js';

/** What the invitation page may show before sign-in: nothing beyond what the invitation email already said. */
export interface InvitationPreview {
  workspaceName: string;
  email: string;
  role: InvitableRole;
  expiresAt: Date;
}

/**
 * The invitation behind a token, across workspaces (invitations of deleted workspaces are invisible). Every token,
 * well-formed or not, is hashed and looked up the same way, so an unknown token costs the same as a known one; the
 * lookup is an index match on the hash of a 256-bit token, which leaks nothing usable through timing.
 */
function findByToken(deps: Pick<Deps, 'db'>, token: string) {
  const tokenHash = hashInvitationToken(token);
  return withSystem(deps.db, SYSTEM, (s) => findInvitationByTokenHash(s, tokenHash));
}

/** The preview of an open invitation; null for an unknown, revoked, accepted or expired one. */
export async function lookupInvitation(
  deps: Pick<Deps, 'db' | 'clock'>,
  token: string,
): Promise<InvitationPreview | null> {
  const inv = await findByToken(deps, token);
  if (!inv || inv.acceptedAt || inv.expiresAt <= deps.clock.now()) return null;
  return {
    workspaceName: inv.workspaceName,
    email: inv.email,
    role: inv.role,
    expiresAt: inv.expiresAt,
  };
}

/**
 * Accepts an invitation for the signed-in user, in two steps: the token is resolved across workspaces, then the
 * membership and the acceptance are written in that workspace's transaction.
 *
 * The session's email must be the invited one (403 email_mismatch); with SMTP configured it must also be verified
 * (403 email_not_verified). An unknown, revoked or expired token and an invitation of a deleted workspace are 404.
 * Accepting the same invitation again as the member it made is answered 200 again, without new audit entries. An
 * invitation of a personal workspace is 409 personal_workspace.
 *
 * The transaction takes the workspace lock first, the lock workspace deletion takes too, so an acceptance either
 * commits before a concurrent delete or sees the workspace gone (404); without it the membership insert would not
 * wait for the delete. The invitation row is then locked (FOR UPDATE) against a concurrent revoke or acceptance.
 */
export async function acceptInvitation(
  deps: Pick<Deps, 'db' | 'clock' | 'mailer'>,
  user: SessionUser,
  token: string,
): Promise<{ workspaceId: string; role: WorkspaceRole }> {
  const found = await findByToken(deps, token);
  if (!found) throw notFound();
  if (found.email !== user.email.trim().toLowerCase()) {
    throw new ProblemError(403, 'forbidden', 'email_mismatch');
  }
  const actor = { kind: 'user' as const, userId: user.id };
  return withTenant(deps.db, tenantScope(found.workspaceId), async (t) => {
    const ws = await lockWorkspaceForUpdate(t);
    if (!ws) throw notFound();
    // Personal workspaces take no invitations; creation refuses them, and so does acceptance.
    if (ws.kind === 'personal') throw new ProblemError(409, 'conflict', 'personal_workspace');
    const inv = await getInvitationForUpdate(t, found.id);
    if (!inv) throw notFound();
    const existing = await getMembership(t, user.id);
    if (inv.acceptedAt) {
      if (existing) return { workspaceId: inv.workspaceId, role: existing.role };
      throw notFound();
    }
    if (inv.expiresAt <= deps.clock.now()) throw notFound();
    if (deps.mailer && !user.emailVerified) {
      throw new ProblemError(403, 'forbidden', 'email_not_verified');
    }
    if (!existing) {
      await addMembership(t, { userId: user.id, role: inv.role, via: 'invitation' }, actor);
    }
    // Re-checks open and unexpired in the same UPDATE: false when it expired since the check above (rolls back).
    if (!(await markInvitationAccepted(t, inv.id, actor))) throw notFound();
    return { workspaceId: inv.workspaceId, role: existing?.role ?? inv.role };
  });
}
