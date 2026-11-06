import { isUuid } from '@owlwire/core';
import { asc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { q } from '../repos/context.js';
import type { WorkspaceRow } from '../repos/workspaces.js';
import {
  apps,
  connections,
  deliveries,
  digests,
  events,
  installations,
  workspaces,
} from '../schema/index.js';
import type { SystemTx } from '../scope.js';

type InstallationSelect = typeof installations.$inferSelect;
type AppSelect = typeof apps.$inferSelect;
export type InstallationAuthRecord = Pick<
  InstallationSelect,
  'id' | 'workspaceId' | 'appId' | 'status' | 'grantedTypes' | 'tokenHash'
> & {
  appVisibility: AppSelect['visibility'];
  appApprovalStatus: AppSelect['approvalStatus'];
  appOwnerWorkspaceId: string;
  workspaceDeleted: boolean;
  /** The app's owner workspace is soft-deleted: the app is gone for every workspace that installed it. */
  appOwnerWorkspaceDeleted: boolean;
};
const ownerWorkspaces = alias(workspaces, 'owner_workspaces');

export type TenantEntityKind = 'event' | 'delivery' | 'digest' | 'connection' | 'installation';

/**
 * Kiracılar arası tek okuma: token hash'inden kurulum, app ve workspace durumu. İçerik döndürmez.
 * İptal edilmiş kurulum da `status: 'revoked'` ile döner; kimlik doğrulama katmanı iptal ile bilinmeyeni
 * ayırt eder ve `status !== 'active'` olanı reddeder. Eşleşme `token_hash` üzerindeki unique indeksle yapılır.
 */
export async function findInstallationByTokenHash(
  s: SystemTx,
  tokenHash: string,
): Promise<InstallationAuthRecord | null> {
  const rows = await q(s)
    .select({
      id: installations.id,
      workspaceId: installations.workspaceId,
      appId: installations.appId,
      status: installations.status,
      grantedTypes: installations.grantedTypes,
      tokenHash: installations.tokenHash,
      appVisibility: apps.visibility,
      appApprovalStatus: apps.approvalStatus,
      appOwnerWorkspaceId: apps.ownerWorkspaceId,
      workspaceDeleted: sql<boolean>`${workspaces.deletedAt} is not null`,
      appOwnerWorkspaceDeleted: sql<boolean>`${ownerWorkspaces.deletedAt} is not null`,
    })
    .from(installations)
    .innerJoin(apps, eq(apps.id, installations.appId))
    .innerJoin(workspaces, eq(workspaces.id, installations.workspaceId))
    .innerJoin(ownerWorkspaces, eq(ownerWorkspaces.id, apps.ownerWorkspaceId))
    .where(eq(installations.tokenHash, tokenHash));
  return rows[0] ?? null;
}

/**
 * Worker işlerinin payload'ı yalnız kimlik taşır; işlemeden önce workspace bulunur.
 * Geçersiz ya da bilinmeyen kimlik null döner (SQL'e gönderilmeden önce UUID biçimi denetlenir).
 */
export async function resolveWorkspaceOf(
  s: SystemTx,
  kind: TenantEntityKind,
  id: string,
): Promise<string | null> {
  if (!isUuid(id)) return null;
  const tx = q(s);
  let rows: Array<{ workspaceId: string }>;
  switch (kind) {
    case 'event':
      rows = await tx
        .select({ workspaceId: events.workspaceId })
        .from(events)
        .where(eq(events.id, id));
      break;
    case 'delivery':
      rows = await tx
        .select({ workspaceId: deliveries.workspaceId })
        .from(deliveries)
        .where(eq(deliveries.id, id));
      break;
    case 'digest':
      rows = await tx
        .select({ workspaceId: digests.workspaceId })
        .from(digests)
        .where(eq(digests.id, id));
      break;
    case 'connection':
      rows = await tx
        .select({ workspaceId: connections.workspaceId })
        .from(connections)
        .where(eq(connections.id, id));
      break;
    case 'installation':
      rows = await tx
        .select({ workspaceId: installations.workspaceId })
        .from(installations)
        .where(eq(installations.id, id));
      break;
    default: {
      const unknownKind: never = kind;
      throw new TypeError(`unknown entity kind: ${String(unknownKind)}`);
    }
  }
  return rows[0]?.workspaceId ?? null;
}

export async function listWorkspaces(s: SystemTx): Promise<WorkspaceRow[]> {
  return q(s).select().from(workspaces).orderBy(asc(workspaces.createdAt), asc(workspaces.id));
}
