import { isUuid, newId } from '@owlwire/core';
import { and, desc, eq, lt, or, type SQL } from 'drizzle-orm';
import { mapPgErrors, RepoInputError, RepoNotFoundError } from '../errors.js';
import { deliveries } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type ConnectionRow, getConnection, readConnectionConfig } from './connections.js';
import { assertIdShape, now, q } from './context.js';
import { type DestinationRow, getDestination, lockVisibleDestinations } from './destinations.js';
import { type EventRow, getEvent } from './events.js';
import { connectionQueue, enqueueJob, sendJobKey } from './jobs.js';

export type DeliveryRow = typeof deliveries.$inferSelect;
type DeliveryInsert = typeof deliveries.$inferInsert;

export interface NewDeliveryTarget {
  destinationId: string;
  connectionId: string;
  runAt?: Date;
}

export interface DeliveryPatch {
  status?: NonNullable<DeliveryInsert['status']>;
  attempts?: number;
  nextAttemptAt?: Date | null;
  lastError?: string | null;
  platformMessageId?: string | null;
  deliveredAt?: Date | null;
  digestId?: string | null;
}

export interface DeliveryContext {
  delivery: DeliveryRow;
  event: EventRow;
  destination: DestinationRow;
  connection: ConnectionRow;
  config: Record<string, unknown> | null;
}

export interface ListDeliveriesOptions {
  limit?: number;
  before?: { createdAt: Date; id: string };
}

const byId = (t: TenantTx, id: string) =>
  and(eq(deliveries.workspaceId, t.workspaceId), eq(deliveries.id, id));

/**
 * UNIQUE(event_id, destination_id): yalnız yeni satırları döndürür ve yalnız onlar için `send_delivery` ekler
 * (kuyruk `connectionQueue`, anahtar `sendJobKey`, `replace`). Olay bu workspace'te görünmeli
 * (RepoNotFoundError('event')); her hedef `lockVisibleDestinations` ile görünür olmalı
 * (RepoNotFoundError('destination')) ve hedefin `connectionId`'si hedefin gerçek bağlantısı olmalıdır
 * (RepoInputError) — aksi halde bir hedefin gönderimleri başka bir bağlantının kuyruğuna girerdi. Aynı hedef birden
 * çok verilirse sonuncusu geçerlidir. Bağlantı `FOR SHARE` kilidi, eşzamanlı `deleteConnection`'ın yeni teslimatları
 * da başarısız işaretlemesini sağlar.
 */
export async function createDeliveries(
  t: TenantTx,
  eventId: string,
  targets: readonly NewDeliveryTarget[],
): Promise<DeliveryRow[]> {
  if (targets.length === 0) return [];
  assertIdShape('event', eventId);
  const event = await getEvent(t, eventId);
  if (!event) throw new RepoNotFoundError('event', eventId);
  const byDestination = new Map(targets.map((target) => [target.destinationId, target]));
  // Sabit sıra: eşzamanlı iki çağrı benzersiz indeks girdilerini aynı sırada kilitler (40P01 olmaz).
  const ordered = [...byDestination.values()].sort((x, y) =>
    x.destinationId < y.destinationId ? -1 : x.destinationId > y.destinationId ? 1 : 0,
  );
  const visibleRows = await lockVisibleDestinations(
    t,
    ordered.map((target) => target.destinationId),
  );
  for (const dest of visibleRows) {
    if (byDestination.get(dest.id)?.connectionId !== dest.connectionId) {
      throw new RepoInputError('delivery', 'connectionId does not match the destination');
    }
  }
  const ts = now(t);
  const rows = await mapPgErrors('event', eventId, () =>
    q(t)
      .insert(deliveries)
      .values(
        ordered.map((target) => ({
          id: newId(),
          workspaceId: t.workspaceId,
          eventId,
          destinationId: target.destinationId,
          connectionId: target.connectionId,
          createdAt: ts,
          updatedAt: ts,
        })),
      )
      .onConflictDoNothing({ target: [deliveries.eventId, deliveries.destinationId] })
      .returning(),
  );
  for (const d of rows) {
    await enqueueJob(
      t,
      'send_delivery',
      { deliveryId: d.id },
      {
        queueName: connectionQueue(d.connectionId),
        jobKey: sendJobKey(d.id),
        jobKeyMode: 'replace',
        runAt: byDestination.get(d.destinationId)?.runAt,
      },
    );
  }
  return rows;
}

export async function getDelivery(t: TenantTx, id: string): Promise<DeliveryRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q(t).select().from(deliveries).where(byId(t, id));
  return rows[0] ?? null;
}

export async function updateDelivery(t: TenantTx, id: string, patch: DeliveryPatch): Promise<void> {
  assertIdShape('delivery', id);
  if (patch.digestId != null && !isUuid(patch.digestId)) {
    throw new RepoInputError('delivery', 'digestId must be a uuid');
  }
  const rows = await q(t)
    .update(deliveries)
    .set({ ...patch, updatedAt: now(t) })
    .where(byId(t, id))
    .returning({ id: deliveries.id });
  if (!rows[0]) throw new RepoNotFoundError('delivery', id);
}

/**
 * En yeni önce, (created_at, id) anahtar kümesi imleciyle. `created_at` timestamptz(3)'tür (migration
 * 0005): imleç bir JS Date (ms) olduğundan saklanan değer daha ince olsaydı aynı ms içindeki satırlar atlanırdı.
 * `limit` 1..200 aralığına sıkıştırılır (varsayılan 50). Geçersiz imleç (tarih ya da UUID olmayan kimlik) RepoInputError.
 */
export async function listDeliveries(
  t: TenantTx,
  opts: ListDeliveriesOptions = {},
): Promise<DeliveryRow[]> {
  const requested = Number.isFinite(opts.limit) ? Math.trunc(opts.limit ?? 50) : 50;
  const limit = Math.min(Math.max(requested, 1), 200);
  const conditions: SQL[] = [eq(deliveries.workspaceId, t.workspaceId)];
  if (opts.before) {
    const { createdAt, id } = opts.before;
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime()) || !isUuid(id)) {
      throw new RepoInputError('delivery', 'before must hold a valid createdAt and a uuid id');
    }
    const cursor = or(
      lt(deliveries.createdAt, opts.before.createdAt),
      and(eq(deliveries.createdAt, opts.before.createdAt), lt(deliveries.id, opts.before.id)),
    );
    if (cursor) conditions.push(cursor);
  }
  return q(t)
    .select()
    .from(deliveries)
    .where(and(...conditions))
    .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
    .limit(limit);
}

/**
 * Gönderim için gereken her şeyi aynı transaction'da okur; yapılandırma `send` amacıyla çözülür (denetim kaydı
 * yazılmaz; DEK `readConnectionConfig` içinde açılıp sıfırlanır). Teslimat görünmüyorsa ya da hedefi veya
 * bağlantısı yumuşak silinmişse null döner: `deleteConnection` bekleyen teslimatları zaten başarısız işaretler,
 * çağıran (send_delivery) null'ı "gönderilecek bir şey yok" olarak ele alır. Bağlantı okumalar arasında silinirse de
 * (`readConnectionConfig` RepoNotFoundError) null döner; diğer hatalar (ör. LegacySecretError) iletilir. Sorgular sırayla çalışır (tek
 * transaction istemcisi).
 */
export async function loadDeliveryContext(
  t: TenantTx,
  id: string,
): Promise<DeliveryContext | null> {
  const delivery = await getDelivery(t, id);
  if (!delivery) return null;
  const event = await getEvent(t, delivery.eventId);
  const destination = await getDestination(t, delivery.destinationId);
  const connection = await getConnection(t, delivery.connectionId);
  if (!event || !destination || !connection) return null;
  let config: Record<string, unknown> | null;
  try {
    config = await readConnectionConfig(t, connection.id, { purpose: 'send' });
  } catch (err) {
    // getConnection ile bu okuma arasında commit eden deleteConnection (READ COMMITTED): belgelenen null.
    if (err instanceof RepoNotFoundError) return null;
    throw err;
  }
  return { delivery, event, destination, connection, config };
}
