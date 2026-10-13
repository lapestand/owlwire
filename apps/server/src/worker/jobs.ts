import {
  connectionQueue,
  enqueueJob,
  type JobName,
  routeQueue,
  sendJobKey,
  TENANT_JOB_PAYLOAD_KEY,
  type TenantTx,
  tenantJobName,
} from '@owlwire/db';

export const ROUTE_EVENT_TASK: JobName = 'route_event';
export const SEND_DELIVERY_TASK: JobName = 'send_delivery';
export { connectionQueue, routeQueue, sendJobKey, TENANT_JOB_PAYLOAD_KEY, tenantJobName };

/**
 * Thin wrappers over `@owlwire/db` enqueueJob (R45, R62): the only `graphile_worker.add_job` call lives there.
 * With a TenantTx the queue name and job key are namespaced `w:<workspaceId>:` and the payload gets `_ws`.
 * insertEvent and createDeliveries already enqueue their jobs; these serve re-scheduling and later callers.
 */
export async function enqueueRouteEvent(
  t: TenantTx,
  args: { eventId: string; installationId: string },
): Promise<void> {
  await enqueueJob(
    t,
    ROUTE_EVENT_TASK,
    { eventId: args.eventId },
    { queueName: routeQueue(args.installationId) },
  );
}

/** job_key_mode 'replace' turns a re-schedule of the same delivery into an update of its job. */
export async function enqueueSendDelivery(
  t: TenantTx,
  args: { deliveryId: string; connectionId: string; runAt: Date },
): Promise<void> {
  await enqueueJob(
    t,
    SEND_DELIVERY_TASK,
    { deliveryId: args.deliveryId },
    {
      queueName: connectionQueue(args.connectionId),
      jobKey: sendJobKey(args.deliveryId),
      jobKeyMode: 'replace',
      runAt: args.runAt,
    },
  );
}
