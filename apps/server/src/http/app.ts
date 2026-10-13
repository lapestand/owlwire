import type { Clock } from '@owlwire/core';
import type { Db } from '@owlwire/db';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Logger } from 'pino';
import type { ServerConfig } from '../config/load.js';
import { requestId } from './middleware/request-id.js';
import { ProblemError, problem } from './problem.js';
import { dbReadiness, healthRoutes } from './routes/health.js';
import { v1Routes } from './routes/v1/index.js';
import { staticHandler } from './static.js';
import type { AppEnv } from './types.js';

export interface AppDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  config: Pick<ServerConfig, 'devAdminToken'>;
  webDir: string | null;
  checkReady?: () => Promise<boolean>;
}

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
    (c.get('log') ?? deps.logger).error({ err }, 'unhandled error');
    return problem(c, new ProblemError(500, 'internal'));
  });
  app.notFound((c) => problem(c, new ProblemError(404, 'not_found')));

  app.route('/', healthRoutes(deps.checkReady ?? dbReadiness(deps.db)));
  app.route('/v1', v1Routes({ db: deps.db }));

  if (deps.webDir) app.get('*', staticHandler(deps.webDir));
  return app;
}
