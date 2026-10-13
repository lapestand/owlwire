import { newId } from '@owlwire/core';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { mapPgErrors, RepoNotFoundError } from '../errors.js';
import { connections, destinations } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { now, q } from './context.js';

export type DestinationRow = typeof destinations.$inferSelect;
type DestinationInsert = typeof destinations.$inferInsert;

export interface CreateDestinationInput {
  connectionId: string;
  kind: DestinationInsert['kind'];
  externalId: string;
  externalSubId?: string | null;
  name: string;
  consentStatus?: 'pending' | 'confirmed' | 'revoked';
}

/** Yumuşak silinmemiş bağlantıların kimlikleri (workspace filtresi indeks için açıkça yazılır). */
const liveConnectionIds = (t: TenantTx) =>
  q(t)
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.workspaceId, t.workspaceId), isNull(connections.deletedAt)));

/**
 * R101: yumuşak silinmiş hedefler ve bağlantısı silinmiş hedefler tenant fonksiyonlarında yoktur. Bağlantı koşulu,
 * `deleted_at`'i ayrı tutulan iki kolonun (connections, destinations) ayrışabileceği durumları da kapatır.
 */
export const visible = (t: TenantTx, ...extra: SQL[]) =>
  and(
    eq(destinations.workspaceId, t.workspaceId),
    isNull(destinations.deletedAt),
    inArray(destinations.connectionId, liveConnectionIds(t)),
    ...extra,
  );

/**
 * Bağlantı satırı `FOR SHARE` ile kilitlenir: eşzamanlı `deleteConnection` ya önce biter (bu çağrı
 * RepoNotFoundError alır) ya da bu transaction'ı bekleyip yeni hedefi de yumuşak siler. Başka workspace'in ya da
 * silinmiş bağlantı RepoNotFoundError('connection'); aynı bağlantıda yinelenen dış kimlik RepoConflictError.
 *
 * Kilitlenme uyarısı: `FOR SHARE` (yalnız FK'nin aldığı `FOR KEY SHARE`'den güçlü) bağlantının satır güncellemeleriyle
 * çakışır. Aynı transaction'da önce `createDestination`, sonra aynı bağlantıyı güncelleyen bir çağrı
 * (`updateConnectionStatus`, `updateConnectionConfig`, `deleteConnection`) yapan iki transaction eşzamanlı koşarsa
 * ikisi de paylaşımlı kilidi yükseltmeye çalışır ve 40P01 deadlock oluşur. Çağıranlar bağlantıyı ya önce günceller ya da
 * hedef oluşturduktan sonra aynı transaction'da güncellemez.
 */
export async function createDestination(
  t: TenantTx,
  input: CreateDestinationInput,
): Promise<DestinationRow> {
  const conn = await q(t)
    .select({ id: connections.id })
    .from(connections)
    .where(
      and(
        eq(connections.workspaceId, t.workspaceId),
        eq(connections.id, input.connectionId),
        isNull(connections.deletedAt),
      ),
    )
    .for('share');
  if (!conn[0]) throw new RepoNotFoundError('connection', input.connectionId);
  const id = newId();
  const ts = now(t);
  const rows = await mapPgErrors('destination', id, () =>
    q(t)
      .insert(destinations)
      .values({
        id,
        workspaceId: t.workspaceId,
        connectionId: input.connectionId,
        kind: input.kind,
        externalId: input.externalId,
        externalSubId: input.externalSubId ?? null,
        name: input.name,
        consentStatus: input.consentStatus ?? 'pending',
        consentedAt: input.consentStatus === 'confirmed' ? ts : null,
        createdAt: ts,
      })
      .returning(),
  );
  const row = rows[0];
  if (!row) throw new Error('destination insert returned no row');
  return row;
}

export async function getDestination(t: TenantTx, id: string): Promise<DestinationRow | null> {
  const rows = await q(t)
    .select()
    .from(destinations)
    .where(visible(t, eq(destinations.id, id)));
  return rows[0] ?? null;
}

export async function listDestinations(
  t: TenantTx,
  filter: { connectionId?: string } = {},
): Promise<DestinationRow[]> {
  const extra: SQL[] = [];
  if (filter.connectionId !== undefined) {
    extra.push(eq(destinations.connectionId, filter.connectionId));
  }
  return q(t)
    .select()
    .from(destinations)
    .where(visible(t, ...extra))
    .orderBy(asc(destinations.createdAt), asc(destinations.id));
}

/** Yinelenen kimlikler tek satır döner, bilinmeyen/başka workspace'e ait kimlikler atlanır; sıra garanti edilmez. */
export async function getDestinationsByIds(
  t: TenantTx,
  ids: readonly string[],
): Promise<DestinationRow[]> {
  if (ids.length === 0) return [];
  return q(t)
    .select()
    .from(destinations)
    .where(visible(t, inArray(destinations.id, [...new Set(ids)])));
}

export async function updateDestinationStatus(
  t: TenantTx,
  id: string,
  status: 'active' | 'broken',
  reason: string | null,
): Promise<void> {
  const rows = await q(t)
    .update(destinations)
    .set({ status, statusReason: reason })
    .where(visible(t, eq(destinations.id, id)))
    .returning({ id: destinations.id });
  if (!rows[0]) throw new RepoNotFoundError('destination', id);
}
