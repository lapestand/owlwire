import { isQueueSchemaReady, type OwlwireDb } from '@owlwire/db';
import { Hono } from 'hono';
import { ProblemError } from '../../errors.js';
import type { AppEnv } from '../types.js';

export function dbReadiness(db: OwlwireDb): () => Promise<boolean> {
  return () => isQueueSchemaReady(db);
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
