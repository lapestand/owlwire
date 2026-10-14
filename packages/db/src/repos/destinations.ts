import { isUuid, newId } from '@owlwire/core';
import { and, asc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { mapPgErrors, RepoNotFoundError } from '../errors.js';
import { connections, destinations } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { assertIdShape, MALFORMED_ID, now, q } from './context.js';

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
 * Yumuşak silinmiş hedefler ve bağlantısı silinmiş hedefler tenant fonksiyonlarında yoktur. Bağlantı koşulu,
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
  assertIdShape('connection', input.connectionId);
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
  if (!isUuid(id)) return null;
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
    if (!isUuid(filter.connectionId)) return [];
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
  const unique = [...new Set(ids)].filter(isUuid);
  if (unique.length === 0) return [];
  return q(t)
    .select()
    .from(destinations)
    .where(visible(t, inArray(destinations.id, unique)));
}

/**
 * Paket içi (index'ten dışa verilmez). Kimliklerin hepsinin görünür olduğunu kanıtlar ve bağlantılarını `FOR SHARE`
 * kilitler; böylece eşzamanlı `deleteConnection` ya bu transaction'dan önce biter (hedef görünmez,
 * RepoNotFoundError) ya da bitmesini bekleyip bu transaction'ın yazdığı kural hedeflerini, üyelikleri ve bekleyen
 * teslimatları da temizler. Bağlantılar kimliğe göre sıralı kilitlenir; kilitten sonra görünürlük yeniden okunur
 * (READ COMMITTED: yeni anlık görüntü). Görünmeyen (bilinmeyen, başka workspace'in, yumuşak silinmiş ya da
 * bağlantısı silinmiş) ilk kimlik RepoNotFoundError('destination') verir. Kilitlenme uyarısı `createDestination`
 * ile aynıdır: çağıran aynı transaction'da bağlantı satırını güncelledikten sonra bunu çağırmamalıdır.
 */
export async function lockVisibleDestinations(
  t: TenantTx,
  ids: readonly string[],
): Promise<DestinationRow[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  if (!unique.every(isUuid)) throw new RepoNotFoundError('destination', MALFORMED_ID);
  const first = await q(t)
    .select({ connectionId: destinations.connectionId })
    .from(destinations)
    .where(visible(t, inArray(destinations.id, unique)));
  const connectionIds = [...new Set(first.map((r) => r.connectionId))].sort();
  if (connectionIds.length > 0) {
    await q(t)
      .select({ id: connections.id })
      .from(connections)
      .where(
        and(eq(connections.workspaceId, t.workspaceId), inArray(connections.id, connectionIds)),
      )
      .orderBy(asc(connections.id))
      .for('share');
  }
  const rows = await q(t)
    .select()
    .from(destinations)
    .where(visible(t, inArray(destinations.id, unique)));
  const seen = new Set(rows.map((r) => r.id));
  const missing = unique.find((id) => !seen.has(id));
  if (missing !== undefined) throw new RepoNotFoundError('destination', missing);
  return rows;
}

export async function updateDestinationStatus(
  t: TenantTx,
  id: string,
  status: 'active' | 'broken',
  reason: string | null,
): Promise<void> {
  assertIdShape('destination', id);
  const rows = await q(t)
    .update(destinations)
    .set({ status, statusReason: reason })
    .where(visible(t, eq(destinations.id, id)))
    .returning({ id: destinations.id });
  if (!rows[0]) throw new RepoNotFoundError('destination', id);
}
