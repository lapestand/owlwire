import type { OwlwireDb } from '@owlwire/db';
import type { MiddlewareHandler } from 'hono';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { ProblemError } from '../../../errors.js';
import { problem } from '../../problem.js';
import type { AppEnv } from '../../types.js';
import { eventsRoutes } from './events.js';
import { hooksRoutes } from './hooks.js';

export const V1_BODY_LIMIT_BYTES = 64 * 1024;

/** Body limit for every /v1 request: declared or streamed (chunked) bodies above 64 KiB get 413. */
export function v1BodyLimit(): MiddlewareHandler<AppEnv> {
  return bodyLimit({
    maxSize: V1_BODY_LIMIT_BYTES,
    onError: (c) =>
      problem(c, new ProblemError(413, 'payload_too_large', 'request body exceeds 64 KiB')),
  });
}

export function v1Routes(deps: { db: OwlwireDb }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', v1BodyLimit());
  r.route('/', eventsRoutes(deps));
  r.route('/', hooksRoutes(deps));
  return r;
}
