import { isUuid } from '@owlwire/core';
import { and, asc, eq, gt, isNull, or, sql } from 'drizzle-orm';
import { type AppRow, appColumns } from '../repos/apps.js';
import { type AuditActor, writeAudit } from '../repos/audit.js';
import { now, q } from '../repos/context.js';
import { apps, installations, workspaces } from '../schema/index.js';
import type { SystemTx } from '../scope.js';

/** What app key authentication needs: the app, the stored hash that matched and the owner workspace state. */
export interface AppKeyAuthRecord {
  app: AppRow;
  /** The current or the previous key hash, whichever matched; callers compare it in constant time. */
  keyHash: string;
  ownerWorkspaceDeleted: boolean;
}

/**
 * App key lookup across workspaces: the current key, or the previous key until it expires. Approval and the owner
 * workspace state are returned, not filtered, so the caller decides how to answer them.
 */
export async function findAppByKeyHash(
  s: SystemTx,
  hash: string,
  at: Date,
): Promise<AppKeyAuthRecord | null> {
  const rows = await q(s)
    .select({
      app: appColumns,
      keyHash: sql<string>`case when ${apps.appKeyHash} = ${hash} then ${apps.appKeyHash} else ${apps.appKeyPrevHash} end`,
      ownerWorkspaceDeleted: sql<boolean>`${workspaces.deletedAt} is not null`,
    })
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.ownerWorkspaceId))
    .where(
      or(
        eq(apps.appKeyHash, hash),
        and(eq(apps.appKeyPrevHash, hash), gt(apps.appKeyPrevExpiresAt, at)),
      ),
    );
  return rows[0] ?? null;
}

export async function listPendingPublicApps(
  s: SystemTx,
): Promise<Array<AppRow & { ownerWorkspaceName: string }>> {
  return q(s)
    .select({ ...appColumns, ownerWorkspaceName: workspaces.name })
    .from(apps)
    .innerJoin(workspaces, eq(workspaces.id, apps.ownerWorkspaceId))
    .where(
      and(
        eq(apps.visibility, 'public'),
        eq(apps.approvalStatus, 'pending'),
        isNull(workspaces.deletedAt),
      ),
    )
    .orderBy(asc(apps.createdAt), asc(apps.id));
}

/** Public apps only. Writes app.approval_changed into the owner's workspace when the status changes. */
export async function setApprovalStatus(
  s: SystemTx,
  appId: string,
  to: 'approved' | 'rejected',
  actor: AuditActor,
  note?: string,
): Promise<{
  app: AppRow & { ownerWorkspaceName: string };
  from: AppRow['approvalStatus'];
} | null> {
  if (!isUuid(appId)) return null;
  const current = await q(s)
    .select({ from: apps.approvalStatus, ownerWorkspaceId: apps.ownerWorkspaceId })
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.visibility, 'public')))
    .for('update');
  const before = current[0];
  if (!before) return null;
  const rows = await q(s)
    .update(apps)
    .set({ approvalStatus: to })
    .where(eq(apps.id, appId))
    .returning(appColumns);
  const updated = rows[0];
  if (!updated) return null;
  const [owner] = await q(s)
    .select({ name: workspaces.name })
    .from(workspaces)
    .where(eq(workspaces.id, updated.ownerWorkspaceId));
  const app = { ...updated, ownerWorkspaceName: owner?.name ?? '' };
  if (before.from !== to) {
    await writeAudit(s, {
      workspaceId: before.ownerWorkspaceId,
      action: 'app.approval_changed',
      actor,
      targetType: 'app',
      targetId: appId,
      data: { from: before.from, to, ...(note ? { note } : {}) },
    });
  }
  return { app, from: before.from };
}

/** Revokes every active installation of an app (used when a public app is rejected). */
export async function revokeAppInstallations(
  s: SystemTx,
  appId: string,
  actor: AuditActor,
): Promise<number> {
  if (!isUuid(appId)) return 0;
  const rows = await q(s)
    .update(installations)
    .set({ status: 'revoked', revokedAt: now(s) })
    .where(and(eq(installations.appId, appId), eq(installations.status, 'active')))
    .returning({
      id: installations.id,
      workspaceId: installations.workspaceId,
      tokenPrefix: installations.tokenPrefix,
    });
  for (const row of rows) {
    await writeAudit(s, {
      workspaceId: row.workspaceId,
      action: 'installation.revoked',
      actor,
      targetType: 'installation',
      targetId: row.id,
      data: { appId, tokenPrefix: row.tokenPrefix, reason: 'app_rejected' },
    });
  }
  return rows.length;
}
