import { isUuid, newId } from '@owlwire/core';
import { and, asc, eq, getTableColumns, or } from 'drizzle-orm';
import { mapPgErrors } from '../errors.js';
import { apps } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { now, q } from './context.js';

type AppSelect = typeof apps.$inferSelect;
/** App anahtarı hash'i ve durum webhook sırrı satır tipinde yoktur. */
export type AppRow = Omit<AppSelect, 'appKeyHash' | 'statusWebhookSecretEnc'>;

const {
  appKeyHash: _appKeyHash,
  statusWebhookSecretEnc: _statusWebhookSecretEnc,
  ...appColumns
} = getTableColumns(apps);

export interface CreateAppInput {
  name: string;
  slug: string;
  visibility: 'private' | 'public';
  description?: string | null;
  homepageUrl?: string | null;
}

/**
 * Onay durumu girdiden alınmaz (RLS kiracının kendi app'ini onaylamasını engellemez; moderasyon burada
 * kalır): private app onaylıdır, public app `pending` başlar ve yalnız sistem onayıyla diğer workspace'lere açılır.
 */
export async function createApp(
  t: TenantTx,
  input: CreateAppInput,
  actor: AuditActor,
): Promise<AppRow> {
  const id = newId();
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
        createdAt: now(t),
      })
      .returning(appColumns),
  );
  const row = rows[0];
  if (!row) throw new Error('app insert returned no row');
  await writeAudit(t, {
    action: 'app.created',
    actor,
    targetType: 'app',
    targetId: id,
    data: { visibility: input.visibility },
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
