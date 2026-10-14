import { safeEqual } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import { Hono } from 'hono';
import type { ServerConfig } from '../../config/load.js';
import { listDevDeliveryList } from '../../system/dev-panel.js';
import { extractToken } from '../middleware/installation-auth.js';
import { ProblemError } from '../problem.js';
import type { AppEnv } from '../types.js';

/** Development only: read-only delivery list for the dev panel, guarded by OWLWIRE_DEV_ADMIN_TOKEN. */
export function devRoutes(deps: {
  db: OwlwireDb;
  config: Pick<ServerConfig, 'devAdminToken'>;
}): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', async (c, next) => {
    const expected = deps.config.devAdminToken;
    if (!expected) throw new ProblemError(404, 'not_found');
    const token = extractToken(c.req.header('authorization'), undefined);
    if (!token || !safeEqual(token, expected)) {
      throw new ProblemError(401, 'unauthorized', 'invalid dev admin token', {
        'www-authenticate': 'Bearer',
      });
    }
    await next();
  });

  r.get('/deliveries', async (c) => {
    const requested = Number.parseInt(c.req.query('limit') ?? '', 10);
    const limit = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 500) : 100;
    return c.json(await listDevDeliveryList(deps.db, limit));
  });
  return r;
}
