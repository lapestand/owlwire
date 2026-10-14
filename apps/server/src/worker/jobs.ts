import { connectionQueue, enqueueJob, type JobName, sendJobKey, type TenantTx } from '@owlwire/db';

export const ROUTE_EVENT_TASK: JobName = 'route_event';
export const SEND_DELIVERY_TASK: JobName = 'send_delivery';

/**
 * Thin wrapper over `@owlwire/db` enqueueJob: the only `graphile_worker.add_job` call lives there.
 * With a TenantTx the queue name and job key are namespaced `w:<workspaceId>:` and the payload gets `_ws`.
 * insertEvent and createDeliveries already enqueue their jobs; this one re-schedules a delivery.
 * job_key_mode 'replace' turns a re-schedule of the same delivery into an update of its job.
 */
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
