import { isUuid } from '@owlwire/core';
import { and, count, eq } from 'drizzle-orm';
import { type AuditActor, writeAudit } from '../repos/audit.js';
import { now, q } from '../repos/context.js';
import { authUser } from '../schema/index.js';
import type { SystemTx } from '../scope.js';

export interface AuthUserRow {
  id: string;
  email: string;
  name: string;
  image: string | null;
  emailVerified: boolean;
  isInstanceAdmin: boolean;
  twoFactorEnabled: boolean;
}

const columns = {
  id: authUser.id,
  email: authUser.email,
  name: authUser.name,
  image: authUser.image,
  emailVerified: authUser.emailVerified,
  isInstanceAdmin: authUser.isInstanceAdmin,
  twoFactorEnabled: authUser.twoFactorEnabled,
};

/**
 * Case-insensitive: the input is trimmed and lower-cased, and auth_user.email is stored lower-case (checked by the
 * table), so the lookup uses the unique index on email.
 */
export async function findAuthUserByEmail(s: SystemTx, email: string): Promise<AuthUserRow | null> {
  const rows = await q(s)
    .select(columns)
    .from(authUser)
    .where(eq(authUser.email, email.trim().toLowerCase()))
    .limit(1);
  return rows[0] ?? null;
}

/** A malformed id answers null before any SQL. */
export async function findAuthUserById(s: SystemTx, id: string): Promise<AuthUserRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q(s).select(columns).from(authUser).where(eq(authUser.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Sets is_instance_admin and writes the instance-level instance.admin_granted (no workspace) only when the flag
 * actually changed. Answers false for an existing admin, an unknown user or a malformed id (checked before any SQL).
 */
export async function grantInstanceAdmin(
  s: SystemTx,
  userId: string,
  actor: AuditActor,
): Promise<boolean> {
  if (!isUuid(userId)) return false;
  const rows = await q(s)
    .update(authUser)
    .set({ isInstanceAdmin: true, updatedAt: now(s) })
    .where(and(eq(authUser.id, userId), eq(authUser.isInstanceAdmin, false)))
    .returning({ id: authUser.id });
  if (rows.length === 0) return false;
  await writeAudit(s, {
    workspaceId: null,
    action: 'instance.admin_granted',
    actor,
    targetType: 'instance',
    targetId: userId,
  });
  return true;
}

/** No-op for an unknown or malformed id (checked before any SQL). */
export async function markEmailVerified(s: SystemTx, userId: string): Promise<void> {
  if (!isUuid(userId)) return;
  await q(s)
    .update(authUser)
    .set({ emailVerified: true, updatedAt: now(s) })
    .where(eq(authUser.id, userId));
}

export async function countInstanceAdmins(s: SystemTx): Promise<number> {
  const rows = await q(s)
    .select({ n: count() })
    .from(authUser)
    .where(eq(authUser.isInstanceAdmin, true));
  return rows[0]?.n ?? 0;
}
