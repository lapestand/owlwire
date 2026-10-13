import type { DbOrTx } from '@owlwire/db';
import { sql } from 'drizzle-orm';

export const ROUTE_EVENT_TASK = 'route_event';
export const SEND_DELIVERY_TASK = 'send_delivery';

export const connectionQueue = (connectionId: string) => `conn:${connectionId}`;
export const sendJobKey = (deliveryId: string) => `send:${deliveryId}`;

export async function enqueueRouteEvent(tx: DbOrTx, eventId: string): Promise<void> {
  await tx.execute(
    sql`select graphile_worker.add_job(${ROUTE_EVENT_TASK}::text, json_build_object('eventId', ${eventId}::text))`,
  );
}

/** job_key_mode 'replace' turns a re-schedule of the same delivery into an update of its job. */
export async function enqueueSendDelivery(
  tx: DbOrTx,
  args: { deliveryId: string; connectionId: string; runAt: Date },
): Promise<void> {
  await tx.execute(sql`select graphile_worker.add_job(
    ${SEND_DELIVERY_TASK}::text,
    json_build_object('deliveryId', ${args.deliveryId}::text),
    queue_name := ${connectionQueue(args.connectionId)}::text,
    run_at := ${args.runAt.toISOString()}::timestamptz,
    job_key := ${sendJobKey(args.deliveryId)}::text,
    job_key_mode := 'replace'
  )`);
}
