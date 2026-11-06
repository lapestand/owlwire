import { GENERIC_TYPE_KEY, isUuid, newId } from '@owlwire/core';
import { and, asc, eq, getTableColumns, or, sql } from 'drizzle-orm';
import { mapPgErrors } from '../errors.js';
import { apps, catalogTypes } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';

type AppSelect = typeof apps.$inferSelect;
/** App anahtarı hash'leri (güncel ve önceki) ve durum webhook sırrı satır tipinde yoktur. */
export type AppRow = Omit<AppSelect, 'appKeyHash' | 'appKeyPrevHash' | 'statusWebhookSecretEnc'>;

const {
  appKeyHash: _appKeyHash,
  appKeyPrevHash: _appKeyPrevHash,
  statusWebhookSecretEnc: _statusWebhookSecretEnc,
  ...columns
} = getTableColumns(apps);
/** Package-internal: select list that never contains key hashes or secrets (also used by system/apps.ts). */
export const appColumns = columns;

export interface CreateAppInput {
  name: string;
  slug: string;
  visibility: 'private' | 'public';
  description?: string | null;
  homepageUrl?: string | null;
  /** First app key of a public app; only the hash and the display prefix are stored. */
  appKey?: { hash: string; prefix: string };
}

/**
 * Approval never comes from the input (the apps_approval_guard trigger enforces it as well): a private app
 * starts approved, a public app pending, and only an approval in system mode opens it to other workspaces.
 * Every app gets the reserved generic catalog type in the same transaction.
 */
export async function createApp(
  t: TenantTx,
  input: CreateAppInput,
  actor: AuditActor,
): Promise<AppRow> {
  const id = newId();
  const at = now(t);
  const approvalStatus = input.visibility === 'private' ? 'approved' : 'pending';
  const rows = await mapPgErrors('app', id, () =>
    q(t)
      .insert(apps)
      .values({
        id,
        ownerWorkspaceId: t.workspaceId,
        name: input.name,
        slug: input.slug,
        visibility: input.visibility,
        approvalStatus,
        description: input.description ?? null,
        homepageUrl: input.homepageUrl ?? null,
        appKeyHash: input.appKey?.hash ?? null,
        appKeyPrefix: input.appKey?.prefix ?? null,
        createdAt: at,
      })
      .returning(appColumns),
  );
  const row = rows[0];
  if (!row) throw new Error('app insert returned no row');
  await q(t).insert(catalogTypes).values({
    appId: id,
    key: GENERIC_TYPE_KEY,
    name: 'Generic',
    description: 'Plain notifications sent via /v1/hooks',
    defaultSeverity: 'info',
    payloadSchema: null,
    createdAt: at,
    updatedAt: at,
  });
  await writeAudit(t, {
    action: 'app.created',
    actor,
    targetType: 'app',
    targetId: id,
    data: { visibility: input.visibility, approvalStatus },
  });
  return row;
}

/** Kendi app'leri ve onaylı public app'ler görünür (RLS ile aynı kural, açıkça da filtrelenir). */
export async function getApp(t: TenantTx, id: string): Promise<AppRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q(t)
    .select(appColumns)
    .from(apps)
    .where(
      and(
        eq(apps.id, id),
        or(
          eq(apps.ownerWorkspaceId, t.workspaceId),
          and(eq(apps.visibility, 'public'), eq(apps.approvalStatus, 'approved')),
        ),
      ),
    );
  return rows[0] ?? null;
}

export async function listOwnApps(t: TenantTx): Promise<AppRow[]> {
  return q(t)
    .select(appColumns)
    .from(apps)
    .where(eq(apps.ownerWorkspaceId, t.workspaceId))
    .orderBy(asc(apps.name), asc(apps.id));
}

/** Own apps plus approved public apps of other workspaces (RLS applies the same rule). */
export async function listInstallableApps(
  t: TenantTx,
): Promise<Array<AppRow & { owned: boolean }>> {
  return q(t)
    .select({ ...appColumns, owned: sql<boolean>`${apps.ownerWorkspaceId} = ${t.workspaceId}` })
    .from(apps)
    .where(
      or(
        eq(apps.ownerWorkspaceId, t.workspaceId),
        and(eq(apps.visibility, 'public'), eq(apps.approvalStatus, 'approved')),
      ),
    )
    .orderBy(asc(apps.name), asc(apps.id));
}

/**
 * Makes `next` the current key of an own app; the old current key stays valid until `prevExpiresAt`.
 * The SET expressions read the row's old values (PostgreSQL UPDATE semantics), so the previous key moves over
 * intact. Returns null for an app the tenant does not own.
 */
export async function setAppKey(
  t: TenantTx,
  appId: string,
  next: { hash: string; prefix: string },
  prevExpiresAt: Date,
  actor: AuditActor,
): Promise<{ previousKeyExpiresAt: Date | null } | null> {
  if (!isUuid(appId)) return null; // malformed ids never reach SQL
  const rows = await q(t)
    .update(apps)
    .set({
      appKeyPrevHash: sql`${apps.appKeyHash}`,
      appKeyPrevPrefix: sql`${apps.appKeyPrefix}`,
      appKeyPrevExpiresAt: sql`case when ${apps.appKeyHash} is null then null else ${prevExpiresAt.toISOString()}::timestamptz end`,
      appKeyHash: next.hash,
      appKeyPrefix: next.prefix,
    })
    .where(and(eq(apps.id, appId), eq(apps.ownerWorkspaceId, t.workspaceId)))
    .returning({ previousKeyExpiresAt: apps.appKeyPrevExpiresAt });
  const row = rows[0];
  if (!row) return null;
  await writeAudit(t, {
    action: 'app.key_rotated',
    actor,
    targetType: 'app',
    targetId: appId,
    data: {
      prefix: next.prefix,
      previousKeyExpiresAt: row.previousKeyExpiresAt?.toISOString() ?? null,
    },
  });
  return { previousKeyExpiresAt: row.previousKeyExpiresAt };
}
