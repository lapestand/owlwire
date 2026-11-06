import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import type { Deps } from '../../deps.js';
import {
  consumeIngestBudget,
  INVITATION_BUCKET,
  invitationKeys,
  takeRateBudget,
} from '../../system/rate-limit.js';
import { createClientIpResolver } from '../client-ip.js';
import type { ApiEnv } from '../routes/api/env.js';
import { rateLimitedProblem } from '../routes/api/problems.js';
import type { AppEnv } from '../types.js';

/** One ingest token per request; a batch handler takes the rest of its cost itself. */
export function ingestRateLimit(
  deps: Pick<Deps, 'db' | 'clock' | 'config'>,
  keyOf: (c: Context<AppEnv>) => string,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await consumeIngestBudget(deps, keyOf(c), 1);
    await next();
  };
}

/**
 * Per client address limit for the public invitation endpoints. The address comes from the same resolver as the
 * sign-in limits (trusted proxies only); a request whose address cannot be resolved is not limited.
 */
export function invitationRateLimit(
  deps: Pick<Deps, 'db' | 'clock' | 'config'>,
): MiddlewareHandler<ApiEnv> {
  const resolve = createClientIpResolver(deps.config.trustedProxies);
  return async (c, next) => {
    let socketAddress: string | undefined;
    try {
      socketAddress = getConnInfo(c).remote.address;
    } catch {
      socketAddress = undefined;
    }
    const address = resolve(socketAddress, c.req.header('x-forwarded-for') ?? null);
    if (address) {
      const r = await takeRateBudget(deps, invitationKeys.ip(address), INVITATION_BUCKET, 1);
      if (!r.ok) throw rateLimitedProblem(String(r.retryAfterSeconds));
    }
    await next();
  };
}
