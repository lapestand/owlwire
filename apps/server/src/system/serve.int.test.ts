import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, type Harness } from '../test/harness.js';
import { startServer } from './serve.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
}, 180_000);

afterAll(async () => {
  await h?.close();
});

describe('startServer', () => {
  it('rejects instead of crashing when the port is already in use', async () => {
    const first = await startServer(h.deps, 'api', { port: 0, webDir: null });
    try {
      await expect(
        startServer(h.deps, 'api', { port: first.port ?? 0, webDir: null }),
      ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    } finally {
      await first.stop();
    }
  });

  it('role api serves HTTP without a worker', async () => {
    const running = await startServer(h.deps, 'api', { port: 0, webDir: null });
    try {
      expect(running.worker).toBeNull();
      expect((await fetch(`http://127.0.0.1:${running.port}/readyz`)).status).toBe(200);
    } finally {
      await running.stop();
    }
  });

  it('role worker runs the worker without HTTP', async () => {
    const running = await startServer(h.deps, 'worker', { port: 0, webDir: null });
    try {
      expect(running.port).toBeNull();
      expect(running.worker).toBeInstanceOf(Promise);
    } finally {
      await running.stop();
    }
  });

  it('role all serves HTTP and runs the worker on the RLS-bound application role', async () => {
    const running = await startServer(h.deps, 'all', { port: 0, webDir: null });
    try {
      expect(running.port).toBeGreaterThan(0);
      expect(running.worker).not.toBeNull();
      const { rows } = await h.deps.pool.query<{ user: string }>('select current_user as user');
      expect(rows[0]?.user).toBe('owlwire_app');
    } finally {
      await running.stop();
    }
  });
});
