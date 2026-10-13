import type { Db } from '@owlwire/db';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ProblemError, problem } from '../../problem.js';
import type { AppEnv } from '../../types.js';
import { eventsRoutes } from './events.js';
import { hooksRoutes } from './hooks.js';

export const V1_BODY_LIMIT_BYTES = 64 * 1024;

export function v1Routes(deps: { db: Db }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use(
    '*',
    bodyLimit({
      maxSize: V1_BODY_LIMIT_BYTES,
      onError: (c) =>
        problem(c, new ProblemError(413, 'payload_too_large', 'request body exceeds 64 KiB')),
    }),
  );
  r.route('/', eventsRoutes(deps));
  r.route('/', hooksRoutes(deps));
  return r;
}
