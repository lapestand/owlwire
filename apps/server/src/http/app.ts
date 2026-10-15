import { getConnInfo } from '@hono/node-server/conninfo';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AUTH_BASE_PATH, AUTH_CLIENT_IP_HEADER } from '../auth/auth.js';
import type { Deps } from '../deps.js';
import { notFound, ProblemError, repositoryProblem } from '../errors.js';
import { type ClientIpResolver, createClientIpResolver } from './client-ip.js';
import { requestId } from './middleware/request-id.js';
import { problem } from './problem.js';
import { API_BASE_PATH, createApiRouter } from './routes/api/index.js';
import { dbReadiness, healthRoutes } from './routes/health.js';
import { v1Routes } from './routes/v1/index.js';
import { staticHandler } from './static.js';
import type { AppEnv } from './types.js';

export type AppDeps = Deps & { webDir: string | null; checkReady?: () => Promise<boolean> };

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
    // Repository and audit guard errors get the same fixed details as on /api: never an id, a key or the input.
    const mapped = repositoryProblem(err);
    if (mapped) return problem(c, mapped);
    // The logger's err serializer drops query params, pg row fields and echoed input but keeps code and constraint.
    (c.get('log') ?? deps.logger).error({ err }, 'unhandled error');
    return problem(c, new ProblemError(500, 'internal'));
  });
  app.notFound((c) => problem(c, notFound()));

  app.route('/', healthRoutes(deps.checkReady ?? dbReadiness(deps.db)));
  app.on(['GET', 'POST'], `${AUTH_BASE_PATH}/*`, (c) =>
    deps.auth.handler(withClientIp(c, resolveClientIp)),
  );
  app.route(API_BASE_PATH, createApiRouter(deps));
  app.route('/v1', v1Routes({ db: deps.db }));

  if (deps.webDir) app.get('*', staticHandler(deps.webDir));
  return app;
}
