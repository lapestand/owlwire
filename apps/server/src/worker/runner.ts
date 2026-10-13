import { safeErrorMessage } from '@owlwire/db';
import { Logger as GraphileLogger, type Runner, run, type TaskList } from 'graphile-worker';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { Deps } from '../deps.js';
import { ROUTE_EVENT_TASK, SEND_DELIVERY_TASK } from './jobs.js';
import { routeEvent } from './tasks/route-event.js';
import { sendDelivery } from './tasks/send-delivery.js';

// `_ws` (TENANT_JOB_PAYLOAD_KEY) is kept as unknown: the tasks compare it with the resolved workspace and drop
// the job on a mismatch; a zod default object would strip it.
const RouteEventPayload = z.object({ eventId: z.string().min(1), _ws: z.unknown().optional() });
const SendDeliveryPayload = z.object({
  deliveryId: z.string().min(1),
  _ws: z.unknown().optional(),
});

/**
 * Graphile logs a failed task's error and stores it in the job row; DrizzleQueryError messages carry query
 * parameters, so the error is replaced with its safeErrorMessage before it leaves the task.
 */
async function sanitized(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw new Error(safeErrorMessage(err));
  }
}

export function createTaskList(deps: Deps): TaskList {
  return {
    [ROUTE_EVENT_TASK]: (payload) =>
      sanitized(() => routeEvent(deps, RouteEventPayload.parse(payload))),
    [SEND_DELIVERY_TASK]: (payload) =>
      sanitized(() => sendDelivery(deps, SendDeliveryPayload.parse(payload))),
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
