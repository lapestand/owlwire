import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import { now, q } from '../repos/context.js';
import type { InvitationRow } from '../repos/invitations.js';
import { invitations, workspaces } from '../schema/index.js';
import type { SystemTx } from '../scope.js';

export interface InvitationLookupRow extends InvitationRow {
  workspaceName: string;
}

/**
 * Looks an invitation up by the hash of its token, across workspaces (the caller hashes the token; the plain token
 * never reaches the database). Accepted and expired invitations are returned too, so the caller can tell them apart;
 * invitations of soft-deleted workspaces are invisible.
 */
export async function findInvitationByTokenHash(
  s: SystemTx,
  tokenHash: string,
): Promise<InvitationLookupRow | null> {
  const rows = await q(s)
    .select({ invitation: invitations, workspaceName: workspaces.name })
    .from(invitations)
    .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
    .where(and(eq(invitations.tokenHash, tokenHash), isNull(workspaces.deletedAt)))
    .limit(1);
  const row = rows[0];
  return row ? { ...row.invitation, workspaceName: row.workspaceName } : null;
}

/** Whether any live workspace holds an open (not accepted, not expired) invitation for the email, case-insensitively. */
export async function hasPendingInvitationForEmail(s: SystemTx, email: string): Promise<boolean> {
  const rows = await q(s)
    .select({ one: sql<number>`1` })
    .from(invitations)
    .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId))
    .where(
      and(
        eq(invitations.email, email.trim().toLowerCase()),
        isNull(invitations.acceptedAt),
        gt(invitations.expiresAt, now(s)),
        isNull(workspaces.deletedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
