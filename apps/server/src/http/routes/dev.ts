import type { DeliveryStatus, DevDeliveryList } from '@owlwire/contracts';
import { safeEqual } from '@owlwire/crypto';
import { connections, type Db, deliveries, destinations, events } from '@owlwire/db';
import { desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { ServerConfig } from '../../config/load.js';
import { extractToken } from '../middleware/installation-auth.js';
import { ProblemError } from '../problem.js';
import type { AppEnv } from '../types.js';

/** P0 only: read-only delivery list for the dev panel, guarded by OWLWIRE_DEV_ADMIN_TOKEN. */
export function devRoutes(deps: {
  db: Db;
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
    const rows = await deps.db
      .select({
        id: deliveries.id,
        eventId: deliveries.eventId,
        status: deliveries.status,
        attempts: deliveries.attempts,
        lastError: deliveries.lastError,
        createdAt: deliveries.createdAt,
        deliveredAt: deliveries.deliveredAt,
        eventType: events.type,
        message: events.message,
        destinationName: destinations.name,
        platform: connections.platform,
      })
      .from(deliveries)
      .innerJoin(events, eq(events.id, deliveries.eventId))
      .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
      .innerJoin(connections, eq(connections.id, deliveries.connectionId))
      .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
      .limit(limit);
    const body: DevDeliveryList = {
      deliveries: rows.map((row) => ({
        id: row.id,
        eventId: row.eventId,
        eventType: row.eventType,
        eventTitle: row.message.title ?? null,
        destinationName: row.destinationName,
        platform: row.platform,
        status: row.status as DeliveryStatus,
        attempts: row.attempts,
        lastError: row.lastError,
        createdAt: row.createdAt.toISOString(),
        deliveredAt: row.deliveredAt ? row.deliveredAt.toISOString() : null,
      })),
    };
    return c.json(body);
  });
  return r;
}
