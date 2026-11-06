import { isUuid, newId } from '@owlwire/core';
import type { Message, Severity } from '@owlwire/core/message';
import { and, eq, sql } from 'drizzle-orm';
import { mapPgErrors, RepoInputError, RepoNotFoundError } from '../errors.js';
import { deliveries, events, installations } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { assertIdShape, now, q } from './context.js';
import { enqueueJob, routeQueue } from './jobs.js';

export type EventRow = typeof events.$inferSelect;

export interface InsertEventInput {
  installationId: string;
  idempotencyKey: string;
  type: string;
  severity: Severity;
  message: Message;
}

/**
 * UNIQUE(installation_id, idempotency_key): tekrar gelen olay aynı eventId'yi döndürür, yeni iş eklemez.
 * Eşzamanlı aynı anahtarlı eklemeler güvenlidir: ikinci INSERT ilk transaction bitene kadar benzersiz indekste
 * bekler; ilki commit ederse `do nothing` olur ve sonraki SELECT (READ COMMITTED, yeni anlık görüntü) o satırı
 * görür, geri alırsa ikinci ekleme kazanır. `route_event` işi aynı transaction'da, kurulumun kuyruğunda eklenir.
 * Kurulum bu workspace'te görünür ve `active` olmalıdır (aksi RepoNotFoundError('installation')); boş anahtar
 * RepoInputError (boş anahtar API'de "yok" sayılır, bu katmana anahtar zorunlu ulaşır).
 */
export async function insertEvent(
  t: TenantTx,
  input: InsertEventInput,
): Promise<{ eventId: string; duplicate: boolean }> {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    throw new RepoInputError('event', 'idempotencyKey must be a non-empty string');
  }
  assertIdShape('installation', input.installationId);
  const inst = await q(t)
    .select({ id: installations.id })
    .from(installations)
    .where(
      and(
        eq(installations.workspaceId, t.workspaceId),
        eq(installations.id, input.installationId),
        eq(installations.status, 'active'),
      ),
    );
  if (!inst[0]) throw new RepoNotFoundError('installation', input.installationId);
  const id = newId();
  const inserted = await mapPgErrors('installation', input.installationId, () =>
    q(t)
      .insert(events)
      .values({
        id,
        workspaceId: t.workspaceId,
        installationId: input.installationId,
        idempotencyKey: input.idempotencyKey,
        type: input.type,
        severity: input.severity,
        message: input.message,
        receivedAt: now(t),
      })
      .onConflictDoNothing({ target: [events.installationId, events.idempotencyKey] })
      .returning({ id: events.id }),
  );
  if (inserted[0]) {
    await enqueueJob(
      t,
      'route_event',
      { eventId: id },
      { queueName: routeQueue(input.installationId) },
    );
    return { eventId: id, duplicate: false };
  }
  const existing = await q(t)
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.workspaceId, t.workspaceId),
        eq(events.installationId, input.installationId),
        eq(events.idempotencyKey, input.idempotencyKey),
      ),
    );
  const row = existing[0];
  if (!row) throw new Error('idempotent event lookup failed');
  return { eventId: row.id, duplicate: true };
}

export async function getEvent(t: TenantTx, id: string): Promise<EventRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q(t)
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, t.workspaceId), eq(events.id, id)));
  return rows[0] ?? null;
}

export async function markEventRouted(t: TenantTx, id: string): Promise<void> {
  assertIdShape('event', id);
  const rows = await q(t)
    .update(events)
    .set({ routedAt: now(t) })
    .where(and(eq(events.workspaceId, t.workspaceId), eq(events.id, id)))
    .returning({ id: events.id });
  if (!rows[0]) throw new RepoNotFoundError('event', id);
}

export interface InsertedEvent {
  eventId: string;
  duplicate: boolean;
}

export interface EventStatus {
  id: string;
  status: 'received' | 'routed';
  deliveries: { total: number; delivered: number; failed: number; pending: number };
}

/**
 * Inserts events in order inside the caller's tenant transaction; each new event gets its route_event job in the
 * same transaction (insertEvent). A repeated (installation_id, idempotency_key), also within one batch, returns
 * the existing id with duplicate=true; under concurrency the unique index makes the second transaction wait.
 */
export async function insertEvents(
  t: TenantTx,
  rows: InsertEventInput[],
): Promise<InsertedEvent[]> {
  const out: InsertedEvent[] = [];
  for (const row of rows) out.push(await insertEvent(t, row));
  return out;
}

export async function getEventStatus(
  t: TenantTx,
  installationId: string,
  eventId: string,
): Promise<EventStatus | null> {
  if (!isUuid(installationId) || !isUuid(eventId)) return null;
  const evs = await q(t)
    .select({ id: events.id, routedAt: events.routedAt })
    .from(events)
    .where(
      and(
        eq(events.id, eventId),
        eq(events.workspaceId, t.workspaceId),
        eq(events.installationId, installationId),
      ),
    );
  const ev = evs[0];
  if (!ev) return null;
  const counts = await q(t)
    .select({
      total: sql<number>`count(*)::int`,
      delivered: sql<number>`(count(*) filter (where ${deliveries.status} in ('delivered', 'digested')))::int`,
      failed: sql<number>`(count(*) filter (where ${deliveries.status} = 'failed'))::int`,
      pending: sql<number>`(count(*) filter (where ${deliveries.status} in ('pending', 'scheduled', 'sending')))::int`,
    })
    .from(deliveries)
    .where(and(eq(deliveries.eventId, eventId), eq(deliveries.workspaceId, t.workspaceId)));
  const c = counts[0];
  return {
    id: ev.id,
    status: ev.routedAt ? 'routed' : 'received',
    deliveries: {
      total: c?.total ?? 0,
      delivered: c?.delivered ?? 0,
      failed: c?.failed ?? 0,
      pending: c?.pending ?? 0,
    },
  };
}
