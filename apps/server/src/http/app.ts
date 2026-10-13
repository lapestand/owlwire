import type { Clock } from '@owlwire/core';
import {
  InvalidScopeError,
  type OwlwireDb,
  RepoConflictError,
  RepoInputError,
  RepoNotFoundError,
} from '@owlwire/db';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'pino';
import type { ServerConfig } from '../config/load.js';
import { requestId } from './middleware/request-id.js';
import { ProblemError, problem } from './problem.js';
import { devRoutes } from './routes/dev.js';
import { dbReadiness, healthRoutes } from './routes/health.js';
import { v1Routes } from './routes/v1/index.js';
import { staticHandler } from './static.js';
import type { AppEnv } from './types.js';

export interface AppDeps {
  db: OwlwireDb;
  clock: Clock;
  logger: Logger;
  config: Pick<ServerConfig, 'devAdminToken'>;
  webDir: string | null;
  checkReady?: () => Promise<boolean>;
}

/** Fixed detail of the 404 for repository not-found and invalid scope errors (final review ruling). */
export const NOT_FOUND_DETAIL = 'The requested resource was not found.';

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', requestId(deps.logger));
  app.onError((err, c) => {
    if (err instanceof ProblemError) return problem(c, err);
    if (err.name === 'BodyLimitError' || (err instanceof HTTPException && err.status === 413)) {
      return problem(c, new ProblemError(413, 'payload_too_large'));
    }
    if (err instanceof HTTPException && err.status === 400) {
      return problem(c, new ProblemError(400, 'validation_failed', err.message || undefined));
    }
    // Repository errors carry only entity/constraint/reason names, never values (P0 contract: 422 / 409).
    if (err instanceof RepoInputError) {
      return problem(c, new ProblemError(422, 'validation_failed', err.message));
    }
    // Unknown, foreign or malformed ids look the same to the caller: a fixed text, never the id or the input.
    if (err instanceof RepoNotFoundError || err instanceof InvalidScopeError) {
      return problem(c, new ProblemError(404, 'not_found', NOT_FOUND_DETAIL));
    }
    if (err instanceof RepoConflictError) {
      return problem(c, new ProblemError(409, 'conflict', err.message));
    }
    // The logger's err serializer drops query params, pg row fields and echoed input but keeps code and constraint (I-6).
    (c.get('log') ?? deps.logger).error({ err }, 'unhandled error');
    return problem(c, new ProblemError(500, 'internal'));
  });
  app.notFound((c) => problem(c, new ProblemError(404, 'not_found')));

  app.route('/', healthRoutes(deps.checkReady ?? dbReadiness(deps.db)));
  app.route('/v1', v1Routes({ db: deps.db }));
  app.route('/api/dev', devRoutes({ db: deps.db, config: deps.config }));

  if (deps.webDir) app.get('*', staticHandler(deps.webDir));
  return app;
}
