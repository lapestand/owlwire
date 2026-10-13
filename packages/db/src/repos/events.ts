import { newId } from '@owlwire/core';
import type { Message, Severity } from '@owlwire/core/message';
import { and, eq } from 'drizzle-orm';
import { mapPgErrors, RepoInputError, RepoNotFoundError } from '../errors.js';
import { events, installations } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { now, q } from './context.js';
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
 * RepoInputError (P0 kuralı: boş anahtar API'de "yok" sayılır, bu katmana anahtar zorunlu ulaşır).
 */
export async function insertEvent(
  t: TenantTx,
  input: InsertEventInput,
): Promise<{ eventId: string; duplicate: boolean }> {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0) {
    throw new RepoInputError('event', 'idempotencyKey must be a non-empty string');
  }
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
  const rows = await q(t)
    .select()
    .from(events)
    .where(and(eq(events.workspaceId, t.workspaceId), eq(events.id, id)));
  return rows[0] ?? null;
}

export async function markEventRouted(t: TenantTx, id: string): Promise<void> {
  const rows = await q(t)
    .update(events)
    .set({ routedAt: now(t) })
    .where(and(eq(events.workspaceId, t.workspaceId), eq(events.id, id)))
    .returning({ id: events.id });
  if (!rows[0]) throw new RepoNotFoundError('event', id);
}
