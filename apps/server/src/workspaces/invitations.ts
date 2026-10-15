import type { InvitableRole } from '@owlwire/core';
import {
  createInvitation,
  deletePendingInvitationsForEmail,
  getMembership,
  type InvitationRow,
  listPendingInvitations,
  revokeInvitation,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import type { SessionUser } from '../auth/session-user.js';
import type { Deps } from '../deps.js';
import { notFound, ProblemError } from '../errors.js';
import { canEmailLinks, INSECURE_LINK_REASON, MAIL_NOT_SENT, mailFailure } from '../mail/links.js';
import { type MailLocale, pickLocale } from '../mail/locale.js';
import { renderMail } from '../mail/templates.js';
import { getRegistrationMode } from '../system/registration.js';
import { findUserByEmail } from '../system/users.js';
import { userActor, type WorkspaceContext } from './context.js';
import { INVITATION_TTL_MS, newInvitationToken } from './invitation-token.js';
import { lockForActor } from './write-lock.js';

export interface CreatedInvitation {
  invitation: InvitationRow;
  acceptUrl: string;
  emailSent: boolean;
}

/** Path of the web page that previews and accepts an invitation; the token is its last segment. */
const INVITE_PATH = '/invite/';

/** The link to the invitation page: the public URL plus the percent-encoded token. */
const acceptLink = (baseURL: string, token: string): string =>
  `${baseURL}${INVITE_PATH}${encodeURIComponent(token)}`;

/**
 * Invites an email address (lower-cased) into the workspace. A personal workspace has only its owner and takes no
 * invitations (409 personal_workspace). Under the workspace lock (see lockForActor) the caller must still be an owner
 * or admin (403 otherwise, 404 when no longer a member); an address that already belongs to a member is 409
 * already_member; a pending invitation for the same address is replaced (invitation.revoked, reason 'replaced') in the
 * same transaction as the new one (invitation.created). While registration is closed, an address with no account is
 * 409 registration_closed, since its owner could never sign up to accept.
 *
 * The email is sent after the commit and awaited, so the answer can say whether it went out: `emailSent` is false
 * without SMTP, for a link that may not be emailed (http public URL in production) and when rendering or sending
 * fails. The invitation stays either way, and `acceptUrl` lets the inviter pass the link on themselves. Apart from
 * the closed-registration refusal, the answer and the email do not depend on whether the address has an account.
 */
export async function inviteMember(
  deps: Pick<Deps, 'db' | 'authDb' | 'clock' | 'mailer' | 'logger' | 'authEnv' | 'config'>,
  ws: WorkspaceContext,
  actor: SessionUser,
  input: { email: string; role: InvitableRole; locale?: MailLocale | undefined },
  acceptLanguage: string | undefined,
): Promise<CreatedInvitation> {
  // The kind of a workspace never changes, so the check needs no lock.
  if (ws.kind === 'personal') throw new ProblemError(409, 'conflict', 'personal_workspace');
  const email = input.email.trim().toLowerCase();
  const existingUser = await findUserByEmail(deps, email);
  // With registration closed nobody can sign up, so an invitation to an address without an account could never be
  // accepted: refuse it rather than store and email a dead link.
  if (!existingUser && (await getRegistrationMode(deps)) === 'closed') {
    throw new ProblemError(409, 'conflict', 'registration_closed');
  }
  const { token, tokenHash } = newInvitationToken();
  const auditActor = userActor(actor.id);

  const invitation = await withTenant(deps.db, tenantScope(ws.id), async (t) => {
    await lockForActor(t, actor.id, 'admin');
    if (existingUser && (await getMembership(t, existingUser.id))) {
      throw new ProblemError(409, 'conflict', 'already_member');
    }
    await deletePendingInvitationsForEmail(t, email, auditActor);
    return createInvitation(
      t,
      {
        email,
        role: input.role,
        tokenHash,
        invitedBy: actor.id,
        expiresAt: new Date(deps.clock.now().getTime() + INVITATION_TTL_MS),
      },
      auditActor,
    );
  });

  const acceptUrl = acceptLink(deps.authEnv.baseURL, token);
  let emailSent = false;
  if (deps.mailer && canEmailLinks(deps.authEnv.baseURL, deps.config.allowHttpLinks)) {
    try {
      const rendered = renderMail(input.locale ?? pickLocale(acceptLanguage), {
        kind: 'invitation',
        workspaceName: ws.name,
        inviterName: actor.name,
        role: input.role,
        url: acceptUrl,
        expiresAt: invitation.expiresAt,
      });
      await deps.mailer.send({ to: email, ...rendered });
      emailSent = true;
    } catch (err) {
      deps.logger.warn(
        {
          kind: 'invitation',
          ...mailFailure(err),
          workspaceId: ws.id,
          invitationId: invitation.id,
        },
        MAIL_NOT_SENT,
      );
    }
  } else if (deps.mailer) {
    deps.logger.warn(
      {
        kind: 'invitation',
        reason: INSECURE_LINK_REASON,
        workspaceId: ws.id,
        invitationId: invitation.id,
      },
      MAIL_NOT_SENT,
    );
  }
  return { invitation, acceptUrl, emailSent };
}

/** Open invitations (not accepted, not expired), oldest first. The route allows owners and admins only. */
export function listWorkspaceInvitations(
  deps: Pick<Deps, 'db'>,
  workspaceId: string,
): Promise<InvitationRow[]> {
  return withTenant(deps.db, tenantScope(workspaceId), (t) => listPendingInvitations(t));
}

/**
 * Revokes a not yet accepted invitation (invitation.revoked, reason 'revoked'). The caller must still be an owner or
 * admin under the workspace lock (403 otherwise); an unknown, foreign or already accepted invitation is 404.
 */
export async function cancelInvitation(
  deps: Pick<Deps, 'db'>,
  workspaceId: string,
  actorUserId: string,
  invitationId: string,
): Promise<void> {
  await withTenant(deps.db, tenantScope(workspaceId), async (t) => {
    await lockForActor(t, actorUserId, 'admin');
    if (!(await revokeInvitation(t, invitationId, userActor(actorUserId)))) throw notFound();
  });
}
