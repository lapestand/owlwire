import { isUuid } from '@owlwire/core';
import type { Severity } from '@owlwire/core/message';
import { and, asc, eq, or, sql } from 'drizzle-orm';
import { apps, catalogTypes } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';

export interface CatalogTypeRow {
  appId: string;
  key: string;
  name: string;
  description: string | null;
  defaultSeverity: Severity;
  payloadSchema: Record<string, unknown> | null;
  updatedAt: Date;
}

export interface CatalogTypeUpsert {
  key: string;
  name: string;
  description: string | null;
  defaultSeverity: Severity;
  payloadSchema: Record<string, unknown> | null;
}

/** Upsert only (never deletes). Returns false when the app is not owned by the tenant. */
export async function upsertCatalogTypes(
  t: TenantTx,
  appId: string,
  types: CatalogTypeUpsert[],
  actor: AuditActor,
  opts: { via?: 'app_key' } = {},
): Promise<boolean> {
  if (!isUuid(appId)) return false;
  const owned = await q(t)
    .select({ id: apps.id })
    .from(apps)
    .where(and(eq(apps.id, appId), eq(apps.ownerWorkspaceId, t.workspaceId)));
  if (owned.length === 0) return false;
  if (types.length === 0) return true;
  const at = now(t);
  await q(t)
    .insert(catalogTypes)
    .values(types.map((type) => ({ appId, ...type, createdAt: at, updatedAt: at })))
    .onConflictDoUpdate({
      target: [catalogTypes.appId, catalogTypes.key],
      set: {
        name: sql`excluded.name`,
        description: sql`excluded.description`,
        defaultSeverity: sql`excluded.default_severity`,
        payloadSchema: sql`excluded.payload_schema`,
        updatedAt: at,
      },
    });
  await writeAudit(t, {
    action: 'catalog.updated',
    actor,
    targetType: 'catalog',
    targetId: appId,
    data: { appId, keys: types.map((type) => type.key), ...(opts.via ? { via: opts.via } : {}) },
  });
  return true;
}

/** Visible when the app is owned by the tenant or is an approved public app (RLS applies the same rule). */
export async function listCatalog(t: TenantTx, appId: string): Promise<CatalogTypeRow[]> {
  if (!isUuid(appId)) return [];
  const rows = await q(t)
    .select({
      appId: catalogTypes.appId,
      key: catalogTypes.key,
      name: catalogTypes.name,
      description: catalogTypes.description,
      defaultSeverity: catalogTypes.defaultSeverity,
      payloadSchema: catalogTypes.payloadSchema,
      updatedAt: catalogTypes.updatedAt,
    })
    .from(catalogTypes)
    .innerJoin(apps, eq(apps.id, catalogTypes.appId))
    .where(
      and(
        eq(catalogTypes.appId, appId),
        or(
          eq(apps.ownerWorkspaceId, t.workspaceId),
          and(eq(apps.visibility, 'public'), eq(apps.approvalStatus, 'approved')),
        ),
      ),
    )
    .orderBy(asc(catalogTypes.key));
  return rows as CatalogTypeRow[];
}
