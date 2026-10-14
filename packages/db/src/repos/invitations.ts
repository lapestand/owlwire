import { type InvitableRole, isUuid, newId } from '@owlwire/core';
import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import { mapPgErrors, RepoInputError } from '../errors.js';
import { invitations } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';

/**
 * An invitation as callers see it. The token hash stays inside the repository layer: it is written once by
 * createInvitation and only ever compared in SQL (findInvitationByTokenHash), never returned.
 */
export interface InvitationRow {
  id: string;
  workspaceId: string;
  email: string;
  role: InvitableRole;
  invitedBy: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

export interface CreateInvitationInput {
  email: string;
  role: InvitableRole;
  /** Hash of the token handed to the invitee; callers hash before calling, the plain token never reaches this layer. */
  tokenHash: string;
  invitedBy: string | null;
  expiresAt: Date;
}

/** Package internal: the InvitationRow columns, shared with the system lookup. Deliberately without token_hash. */
export const invitationColumns = {
  id: invitations.id,
  workspaceId: invitations.workspaceId,
  email: invitations.email,
  role: invitations.role,
  invitedBy: invitations.invitedBy,
  expiresAt: invitations.expiresAt,
  acceptedAt: invitations.acceptedAt,
  createdAt: invitations.createdAt,
};

const EMAIL_LOWER_CHECK = 'invitations_email_lower_check';
const INVITER_FK = 'invitations_invited_by_auth_user_id_fk';
const WORKSPACE_FK = 'invitations_workspace_id_workspaces_id_fk';

/** Invitation emails are stored trimmed and lower-cased (the table checks the lower-case form). */
const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const byId = (t: TenantTx, id: string) =>
  and(eq(invitations.workspaceId, t.workspaceId), eq(invitations.id, id));

/** Not accepted yet; expired rows included (they can still be revoked). */
const notAccepted = (t: TenantTx, id: string) => and(byId(t, id), isNull(invitations.acceptedAt));

/**
 * Creates an invitation and writes invitation.created (email and role only, never the token hash). A second open
 * invitation for the same email in this workspace is RepoConflictError (`invitations_pending_email_uidx`); replace it
 * with deletePendingInvitationsForEmail first. A malformed inviter id, an empty email or token hash and an invalid
 * expiry are RepoInputError before any SQL; an unknown inviter is RepoNotFoundError('user'). An email that Postgres
 * lower() would still change after the JS lower-casing (possible for rare non-ASCII characters under some
 * collations) fails the table's lower-case CHECK and is RepoInputError too.
 *
 * Does not check that the workspace is live: callers reach this only after the workspace access check, which
 * answers 404 for a soft-deleted workspace.
 */
export async function createInvitation(
  t: TenantTx,
  input: CreateInvitationInput,
  actor: AuditActor,
): Promise<InvitationRow> {
  if (input.invitedBy !== null && !isUuid(input.invitedBy)) {
    throw new RepoInputError('invitation', 'malformed inviter id');
  }
  const email = normalizeEmail(input.email);
  if (email === '') throw new RepoInputError('invitation', 'email is empty');
  if (input.tokenHash === '') throw new RepoInputError('invitation', 'token hash is empty');
  if (!(input.expiresAt instanceof Date) || Number.isNaN(input.expiresAt.getTime())) {
    throw new RepoInputError('invitation', 'expiresAt must be a valid Date');
  }
  const id = newId();
  const rows = await mapPgErrors(
    'invitation',
    id,
    () =>
      q(t)
        .insert(invitations)
        .values({
          id,
          workspaceId: t.workspaceId,
          email,
          role: input.role,
          tokenHash: input.tokenHash,
          invitedBy: input.invitedBy,
          expiresAt: input.expiresAt,
          createdAt: now(t),
        })
        .returning(invitationColumns),
    {
      fkNotFound: {
        [INVITER_FK]: { entity: 'user', id: input.invitedBy ?? '' },
        [WORKSPACE_FK]: { entity: 'workspace', id: t.workspaceId },
      },
      checkInput: { [EMAIL_LOWER_CHECK]: 'email is not in lower case form' },
    },
  );
  const row = rows[0];
  if (!row) throw new Error('invitation insert returned no row');
  await writeAudit(t, {
    action: 'invitation.created',
    actor,
    targetType: 'invitation',
    targetId: id,
    data: { email, role: input.role },
  });
  return row;
}

/** Open invitations of the workspace: not accepted and not expired, oldest first. */
export async function listPendingInvitations(t: TenantTx): Promise<InvitationRow[]> {
  return q(t)
    .select(invitationColumns)
    .from(invitations)
    .where(
      and(
        eq(invitations.workspaceId, t.workspaceId),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, now(t)),
      ),
    )
    .orderBy(asc(invitations.createdAt), asc(invitations.id));
}

/**
 * Deletes the not yet accepted invitations (expired ones included) for an email in this workspace, before a
 * re-invite. Writes invitation.revoked with reason 'replaced' per deleted row and answers how many were deleted.
 */
export async function deletePendingInvitationsForEmail(
  t: TenantTx,
  email: string,
  actor: AuditActor,
): Promise<number> {
  const rows = await mapPgErrors('invitation', t.workspaceId, () =>
    q(t)
      .delete(invitations)
      .where(
        and(
          eq(invitations.workspaceId, t.workspaceId),
          eq(invitations.email, normalizeEmail(email)),
          isNull(invitations.acceptedAt),
        ),
      )
      .returning({ id: invitations.id }),
  );
  for (const row of rows) {
    await writeAudit(t, {
      action: 'invitation.revoked',
      actor,
      targetType: 'invitation',
      targetId: row.id,
      data: { reason: 'replaced' },
    });
  }
  return rows.length;
}

/**
 * Revokes (deletes) a not yet accepted invitation and writes invitation.revoked with reason 'revoked'. Answers false
 * for an unknown, already accepted or malformed id (checked before any SQL).
 */
export async function revokeInvitation(
  t: TenantTx,
  id: string,
  actor: AuditActor,
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await mapPgErrors('invitation', id, () =>
    q(t).delete(invitations).where(notAccepted(t, id)).returning({ id: invitations.id }),
  );
  if (rows.length === 0) return false;
  await writeAudit(t, {
    action: 'invitation.revoked',
    actor,
    targetType: 'invitation',
    targetId: id,
    data: { reason: 'revoked' },
  });
  return true;
}

/** Reads and locks (FOR UPDATE) an invitation of this workspace; null for an unknown or malformed id. */
export async function getInvitationForUpdate(
  t: TenantTx,
  id: string,
): Promise<InvitationRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q(t)
    .select(invitationColumns)
    .from(invitations)
    .where(byId(t, id))
    .limit(1)
    .for('update');
  return rows[0] ?? null;
}

/**
 * Marks an open invitation accepted and writes invitation.accepted. Open means not accepted and not expired, both
 * checked by the same UPDATE, so an expired or already accepted invitation can never be accepted, whatever the caller
 * checked before. Answers false for an unknown, expired, already accepted or malformed id. A caller that wants to tell
 * "expired" apart reads the row with getInvitationForUpdate first.
 */
export async function markInvitationAccepted(
  t: TenantTx,
  id: string,
  actor: AuditActor,
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await mapPgErrors('invitation', id, () =>
    q(t)
      .update(invitations)
      .set({ acceptedAt: now(t) })
      .where(and(notAccepted(t, id), gt(invitations.expiresAt, now(t))))
      .returning({ role: invitations.role }),
  );
  const row = rows[0];
  if (!row) return false;
  await writeAudit(t, {
    action: 'invitation.accepted',
    actor,
    targetType: 'invitation',
    targetId: id,
    data: { role: row.role },
  });
  return true;
}
