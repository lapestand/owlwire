import { scrubQueryParams } from '@owlwire/core';
import { safeErrorMessage } from '@owlwire/db';
import {
  Logger as GraphileLogger,
  type JobHelpers,
  type Runner,
  run,
  type TaskList,
} from 'graphile-worker';
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
 * Graphile logs a failed task's error and stores its message in `_private_jobs.last_error`; DrizzleQueryError messages
 * carry query parameters (and JSON SyntaxError / pg data exception messages echo input), so the error is replaced with
 * its safeErrorMessage, without a cause, before it leaves the task.
 */
async function sanitized(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    throw new Error(safeErrorMessage(err));
  }
}

/**
 * Wraps every task of a list in `sanitized`, so no task can reach Graphile with a raw error. createTaskList and
 * startWorker (including its `extraTasks`) register tasks only through here; a task never wraps itself.
 */
export function sanitizeTaskList(tasks: TaskList): TaskList {
  return Object.fromEntries(
    Object.entries(tasks).flatMap(([name, task]) =>
      task
        ? [
            [
              name,
              (payload: unknown, helpers: JobHelpers) =>
                sanitized(async () => task(payload, helpers)),
            ],
          ]
        : [],
    ),
  ) as TaskList;
}

/**
 * A payload that does not parse cannot succeed on retry: like a `_ws` mismatch it is logged with the job id only (the
 * payload itself is not logged) and dropped without throwing, so Graphile does not retry it.
 */
function parsePayload<T>(
  deps: Pick<Deps, 'logger'>,
  task: string,
  schema: z.ZodType<T>,
  payload: unknown,
  helpers: JobHelpers,
): T | null {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  deps.logger.warn(
    { task, jobId: helpers.job.id },
    `${task}: malformed job payload; dropping the job`,
  );
  return null;
}

function rawTaskList(deps: Deps): TaskList {
  return {
    [ROUTE_EVENT_TASK]: async (payload, helpers) => {
      const parsed = parsePayload(deps, ROUTE_EVENT_TASK, RouteEventPayload, payload, helpers);
      if (parsed) await routeEvent(deps, parsed);
    },
    [SEND_DELIVERY_TASK]: async (payload, helpers) => {
      const parsed = parsePayload(deps, SEND_DELIVERY_TASK, SendDeliveryPayload, payload, helpers);
      if (parsed) await sendDelivery(deps, parsed);
    },
  };
}

export function createTaskList(deps: Deps): TaskList {
  return sanitizeTaskList(rawTaskList(deps));
}

/** Graphile `job` nesnesinden yalnız kimlik alanları; `payload` ve `last_error` (önceki hata metni) loglanmaz. */
function jobSummary(job: unknown): unknown {
  if (typeof job !== 'object' || job === null) return job;
  const { id, task_identifier, attempts, max_attempts } = job as Record<string, unknown>;
  return { id, task_identifier, attempts, max_attempts };
}

export function graphileLogger(logger: Logger): GraphileLogger {
  return new GraphileLogger((scope) => (level, message, meta) => {
    // Log gizliliği: Graphile hatayı meta.error'da verir (pino serializer'ı yalnız `err`'e uygulanır) ve mesaja gömer.
    const { error, job, ...rest } = (meta ?? {}) as Record<string, unknown>;
    const ctx = {
      ...scope,
      ...rest,
      ...(job === undefined ? {} : { job: jobSummary(job) }),
      ...(error === undefined ? {} : { err: error }),
    };
    const text = scrubQueryParams(message);
    const lvl = String(level);
    if (lvl === 'error') logger.error(ctx, text);
    else if (lvl === 'warning') logger.warn(ctx, text);
    else if (lvl === 'info') logger.info(ctx, text);
    else logger.debug(ctx, text);
  });
}

export async function startWorker(
  deps: Deps,
  opts: {
    concurrency?: number;
    pollInterval?: number;
    /** Further tasks (later features, tests); wrapped with the built-in ones in sanitizeTaskList. */
    extraTasks?: TaskList;
  } = {},
): Promise<Runner> {
  return run({
    pgPool: deps.pool,
    taskList: sanitizeTaskList({ ...rawTaskList(deps), ...opts.extraTasks }),
    concurrency: opts.concurrency ?? 5,
    pollInterval: opts.pollInterval ?? 2000,
    noHandleSignals: true,
    logger: graphileLogger(deps.logger.child({ component: 'worker' })),
  });
}
