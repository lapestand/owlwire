import type { Message } from '@owlwire/core/message';
import { desc, eq } from 'drizzle-orm';
import { q } from '../repos/context.js';
import { connections, deliveries, destinations, events } from '../schema/index.js';
import type { SystemTx } from '../scope.js';

export interface DevDeliveryRow {
  id: string;
  eventId: string;
  eventType: string;
  message: Message;
  destinationName: string;
  platform: string;
  status: string;
  attempts: number;
  lastError: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

/**
 * P0/P1a dev paneli (instance düzeyi, R48): bütün workspace'lerin teslimatları, en yeni önce.
 * Yalnız apps/server/src/system/dev-panel.ts çağırır; P1b dev ucuyla birlikte kaldırılır.
 * `limit` 1..500 aralığına sıkıştırılır.
 */
export async function listDevDeliveries(
  s: SystemTx,
  opts: { limit: number },
): Promise<DevDeliveryRow[]> {
  const requested = Number.isFinite(opts.limit) ? Math.trunc(opts.limit) : 100;
  const limit = Math.min(Math.max(requested, 1), 500);
  return q(s)
    .select({
      id: deliveries.id,
      eventId: deliveries.eventId,
      eventType: events.type,
      message: events.message,
      destinationName: destinations.name,
      platform: connections.platform,
      status: deliveries.status,
      attempts: deliveries.attempts,
      lastError: deliveries.lastError,
      createdAt: deliveries.createdAt,
      deliveredAt: deliveries.deliveredAt,
    })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
    .innerJoin(connections, eq(connections.id, deliveries.connectionId))
    .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
    .limit(limit);
}
