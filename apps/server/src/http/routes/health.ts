import type { Db } from '@owlwire/db';
import { sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { ProblemError } from '../problem.js';
import type { AppEnv } from '../types.js';

export function dbReadiness(db: Db): () => Promise<boolean> {
  return async () => {
    const res = await db.execute<{ ok: boolean }>(
      sql`select to_regclass('graphile_worker.jobs') is not null as ok`,
    );
    return res.rows[0]?.ok === true;
  };
}

export function healthRoutes(checkReady: () => Promise<boolean>): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.get('/healthz', (c) => c.text('ok'));
  r.get('/readyz', async (c) => {
    let ready = false;
    try {
      ready = await checkReady();
    } catch (err) {
      c.get('log').warn({ err }, 'readiness check failed');
    }
    if (!ready) throw new ProblemError(503, 'unavailable', 'database or queue is not ready');
    return c.json({ status: 'ready' });
  });
  return r;
}
