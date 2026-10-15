import type { InvitableRole } from '@owlwire/core';
import {
  type AuditActor,
  createInvitation,
  deletePendingInvitationsForEmail,
  getMembership,
  type InvitationRow,
  listPendingInvitations,
  revokeInvitation,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import type { Deps } from '../deps.js';
import type { SessionUser } from '../http/middleware/session-auth.js';
import { ProblemError } from '../http/problem.js';
import type { WorkspaceContext } from '../http/routes/api/env.js';
import { notFound } from '../http/routes/api/problems.js';
import { type MailLocale, pickLocale } from '../mail/locale.js';
import { MailMessageError } from '../mail/mailer.js';
import { MailTemplateError, renderMail } from '../mail/templates.js';
import { findUserByEmail } from '../system/users.js';
import { INVITATION_TTL_MS, newInvitationToken } from './invitation-token.js';
import { lockForActor } from './write-lock.js';

export interface CreatedInvitation {
  invitation: InvitationRow;
  acceptUrl: string;
  emailSent: boolean;
}

/** Path of the web page that previews and accepts an invitation; the token is its last segment. */
const INVITE_PATH = '/invite/';

const userActor = (userId: string): AuditActor => ({ kind: 'user', userId });

/**
 * The link to the invitation page: the public URL plus the percent-encoded token. Emailing it needs an https public
 * URL; plain http is accepted only outside production (local development), like the sign-in emails.
 */
function acceptLink(
  baseURL: string,
  token: string,
  nodeEnv: string | undefined,
): { url: string; emailable: boolean } {
  const url = `${baseURL}${INVITE_PATH}${encodeURIComponent(token)}`;
  const protocol = new URL(baseURL).protocol;
  return {
    url,
    emailable: protocol === 'https:' || (protocol === 'http:' && nodeEnv !== 'production'),
  };
}

/** Log fields for a failed invitation email: the error's class and code, never the link, address or message. */
function mailFailure(err: unknown): Record<string, unknown> {
  const reason =
    err instanceof MailTemplateError || err instanceof MailMessageError ? err.name : 'transport';
  const code = (err as { code?: unknown } | null)?.code;
  return { reason, ...(typeof code === 'string' ? { code } : {}) };
}

/**
 * Invites an email address (lower-cased) into the workspace. Under the workspace lock (see lockForActor) the caller
 * must still be an owner or admin (403 otherwise, 404 when no longer a member); an address that already belongs to a
 * member is 409 already_member; a pending invitation for the same address is replaced (invitation.revoked, reason
 * 'replaced') in the same transaction as the new one (invitation.created).
 *
 * The email is sent after the commit and awaited, so the answer can say whether it went out: `emailSent` is false
 * without SMTP, for a link that may not be emailed (http public URL in production) and when rendering or sending
 * fails. The invitation stays either way, and `acceptUrl` lets the inviter pass the link on themselves. The address
 * lookup and the email do not depend on whether the address has an account, so timing tells the inviter nothing
 * the 409 would not.
 */
export async function inviteMember(
  deps: Pick<Deps, 'db' | 'authDb' | 'clock' | 'mailer' | 'logger' | 'authEnv'>,
  ws: WorkspaceContext,
  actor: SessionUser,
  input: { email: string; role: InvitableRole; locale?: MailLocale | undefined },
  acceptLanguage: string | undefined,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): Promise<CreatedInvitation> {
  const email = input.email.trim().toLowerCase();
  const existingUser = await findUserByEmail(deps, email);
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

  const link = acceptLink(deps.authEnv.baseURL, token, nodeEnv);
  let emailSent = false;
  if (deps.mailer && link.emailable) {
    try {
      const rendered = renderMail(input.locale ?? pickLocale(acceptLanguage), {
        kind: 'invitation',
        workspaceName: ws.name,
        inviterName: actor.name,
        role: input.role,
        url: link.url,
        expiresAt: invitation.expiresAt,
      });
      await deps.mailer.send({ to: email, ...rendered });
      emailSent = true;
    } catch (err) {
      deps.logger.warn(
        { ...mailFailure(err), workspaceId: ws.id, invitationId: invitation.id },
        'invitation email not sent',
      );
    }
  } else if (deps.mailer) {
    deps.logger.warn(
      { reason: 'insecure_public_url', workspaceId: ws.id, invitationId: invitation.id },
      'invitation email not sent',
    );
  }
  return { invitation, acceptUrl: link.url, emailSent };
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
