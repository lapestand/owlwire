import type { DeliveryStatus, DevDeliveryList } from '@owlwire/contracts';
import type { OwlwireDb } from '@owlwire/db';
import { listDevDeliveries, SYSTEM, withSystem } from '@owlwire/db/system';

/** GET /api/dev/deliveries response (DevDeliveryList); the read spans workspaces, hence withSystem. */
export async function listDevDeliveryList(db: OwlwireDb, limit: number): Promise<DevDeliveryList> {
  const rows = await withSystem(db, SYSTEM, (s) => listDevDeliveries(s, { limit }));
  return {
    deliveries: rows.map((row) => ({
      id: row.id,
      eventId: row.eventId,
      eventType: row.eventType,
      eventTitle: row.message.title ?? null,
      destinationName: row.destinationName,
      platform: row.platform,
      status: row.status as DeliveryStatus,
      attempts: row.attempts,
      lastError: row.lastError,
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
    })),
  };
}
