import type { OpenAPIHono } from '@hono/zod-openapi';
import type { MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Deps } from '../../../deps.js';
import { ProblemError } from '../../../errors.js';
import { problem } from '../../problem.js';
import type { AppEnv } from '../../types.js';
import { registerEventRoutes } from './events.js';
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

/** Registers the public API on the root app, so every /v1 operation lands in its OpenAPI document. */
export function registerV1Routes(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  app.use('/v1/*', v1BodyLimit());
  registerEventRoutes(app, deps);
  app.route('/v1', hooksRoutes({ db: deps.db }));
}
