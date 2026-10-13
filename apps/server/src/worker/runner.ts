import { Logger as GraphileLogger, type Runner, run, type TaskList } from 'graphile-worker';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { ROUTE_EVENT_TASK, SEND_DELIVERY_TASK } from './jobs.js';
import { routeEvent } from './tasks/route-event.js';
import { sendDelivery } from './tasks/send-delivery.js';

const RouteEventPayload = z.object({ eventId: z.string().min(1) });
const SendDeliveryPayload = z.object({ deliveryId: z.string().min(1) });

export function createTaskList(deps: Deps): TaskList {
  return {
    [ROUTE_EVENT_TASK]: async (payload) => {
      await routeEvent(deps, RouteEventPayload.parse(payload));
    },
    [SEND_DELIVERY_TASK]: async (payload) => {
      await sendDelivery(deps, SendDeliveryPayload.parse(payload));
    },
  };
}

export function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger((scope) => (level, message, meta) => {
    const ctx = { ...scope, ...(meta ?? {}) };
    const lvl = String(level);
    if (lvl === 'error') logger.error(ctx, message);
    else if (lvl === 'warning') logger.warn(ctx, message);
    else if (lvl === 'info') logger.info(ctx, message);
    else logger.debug(ctx, message);
  });
}

export async function startWorker(
  deps: Deps,
  opts: { concurrency?: number; pollInterval?: number } = {},
): Promise<Runner> {
  return run({
    pgPool: deps.pool,
    taskList: createTaskList(deps),
    concurrency: opts.concurrency ?? 5,
    pollInterval: opts.pollInterval ?? 2000,
    noHandleSignals: true,
    logger: graphileLogger(deps.logger.child({ component: 'worker' })),
  });
}
