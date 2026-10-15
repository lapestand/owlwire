import { getConnInfo } from '@hono/node-server/conninfo';
import {
  AuditDataError,
  InvalidScopeError,
  RepoConflictError,
  RepoInputError,
  RepoNotFoundError,
} from '@owlwire/db';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AUTH_BASE_PATH, AUTH_CLIENT_IP_HEADER } from '../auth/auth.js';
import type { Deps } from '../deps.js';
import { type ClientIpResolver, createClientIpResolver } from './client-ip.js';
import { requestId } from './middleware/request-id.js';
import { AUDIT_DATA_DETAIL, NOT_FOUND_DETAIL, ProblemError, problem } from './problem.js';
import { API_BASE_PATH, createApiRouter } from './routes/api/index.js';
import { dbReadiness, healthRoutes } from './routes/health.js';
import { v1Routes } from './routes/v1/index.js';
import { staticHandler } from './static.js';
import type { AppEnv } from './types.js';

export type AppDeps = Deps & { webDir: string | null; checkReady?: () => Promise<boolean> };

export { AUDIT_DATA_DETAIL, NOT_FOUND_DETAIL } from './problem.js';

/**
 * The request handed to the auth library: a copy whose AUTH_CLIENT_IP_HEADER is the resolved client address. A value
 * the client sent in that header is always dropped. Without a socket (app.request() in tests that pass none) the
 * header is simply absent.
 */
function withClientIp(c: Context, resolve: ClientIpResolver): Request {
  const headers = new Headers(c.req.raw.headers);
  headers.delete(AUTH_CLIENT_IP_HEADER);
  let socketAddress: string | undefined;
  try {
    socketAddress = getConnInfo(c).remote.address;
  } catch {
    socketAddress = undefined;
  }
  const address = resolve(socketAddress, c.req.raw.headers.get('x-forwarded-for'));
  if (address) headers.set(AUTH_CLIENT_IP_HEADER, address);
  return new Request(c.req.raw, { headers });
}

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const resolveClientIp = createClientIpResolver(deps.config.trustedProxies, {
    onUntrustedForwarded: () =>
      deps.logger.warn(
        'X-Forwarded-For arrived from a peer that is not in OWLWIRE_TRUSTED_PROXIES; sign-in rate limits use the ' +
          'peer address, so clients behind an unlisted proxy share one limit',
      ),
  });
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
    // Repository errors carry only entity/constraint/reason names, never values (mapped to 422 / 409).
    if (err instanceof RepoInputError) {
      return problem(c, new ProblemError(422, 'validation_failed', err.message));
    }
    // The audit guard rejects input (secret-looking keys, non-JSON data); its message names keys, so the detail is fixed.
    if (err instanceof AuditDataError) {
      return problem(c, new ProblemError(422, 'validation_failed', AUDIT_DATA_DETAIL));
    }
    // Unknown, foreign or malformed ids look the same to the caller: a fixed text, never the id or the input.
    if (err instanceof RepoNotFoundError || err instanceof InvalidScopeError) {
      return problem(c, new ProblemError(404, 'not_found', NOT_FOUND_DETAIL));
    }
    if (err instanceof RepoConflictError) {
      return problem(c, new ProblemError(409, 'conflict', err.message));
    }
    // The logger's err serializer drops query params, pg row fields and echoed input but keeps code and constraint.
    (c.get('log') ?? deps.logger).error({ err }, 'unhandled error');
    return problem(c, new ProblemError(500, 'internal'));
  });
  app.notFound((c) => problem(c, new ProblemError(404, 'not_found')));

  app.route('/', healthRoutes(deps.checkReady ?? dbReadiness(deps.db)));
  app.on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) =>
    deps.auth.handler(withClientIp(c, resolveClientIp)),
  );
  app.route(API_BASE_PATH, createApiRouter(deps));
  app.route('/v1', v1Routes({ db: deps.db }));

  if (deps.webDir) app.get('*', staticHandler(deps.webDir));
  return app;
}
