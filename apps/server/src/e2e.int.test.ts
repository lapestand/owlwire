import type { DevDeliveryList } from '@owlwire/contracts';
import { deliveries } from '@owlwire/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDevWorkspace } from './system/dev-seed.js';
import { type RunningServer, startServer } from './system/serve.js';
import { TEST_DEV_ADMIN_TOKEN } from './test/config.js';
import { createHarness, type Harness } from './test/harness.js';
import { waitFor } from './test/wait.js';

let h: Harness;
let server: RunningServer;
let base: string;

beforeAll(async () => {
  h = await createHarness();
  server = await startServer(h.deps, 'all', { port: 0, webDir: null });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(async () => {
  await server.stop();
  await h.close();
});

describe('walking skeleton', () => {
  it('serves health and readiness over real HTTP', async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);
  });

  it('exposes the worker runner promise so main can watch for crashes', () => {
    expect(server.worker).toBeInstanceOf(Promise);
  });

  it('delivers a hook through route_event and send_delivery to the fake adapter', async () => {
    const seed = await seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
      platform: 'webhook',
      chatId: 'smoke',
    });
    const res = await fetch(`${base}/v1/hooks?token=${seed.token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'Gate opened: 34 ABC 123',
    });
    expect(res.status).toBe(202);
    const { eventId } = (await res.json()) as { eventId: string };

    await waitFor(async () => {
      const rows = await h.deps.db
        .select({ status: deliveries.status })
        .from(deliveries)
        .where(eq(deliveries.eventId, eventId));
      return rows[0]?.status === 'delivered';
    });
    expect(h.fake.sent.at(-1)?.rendered.text).toBe('Gate opened: 34 ABC 123');

    const list = await fetch(`${base}/api/dev/deliveries`, {
      headers: { authorization: `Bearer ${TEST_DEV_ADMIN_TOKEN}` },
    });
    const body = (await list.json()) as DevDeliveryList;
    expect(body.deliveries[0]).toMatchObject({
      eventId,
      status: 'delivered',
      eventType: 'generic',
      platform: 'webhook',
      attempts: 1,
    });
  });

  it('retries a rate limited send through the real runner and records two attempts', async () => {
    const seed = await seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
      platform: 'webhook',
      chatId: 'retry',
    });
    h.fake.nextOutcome({ status: 'rate_limited', retryAfterMs: 0 });
    const res = await fetch(`${base}/v1/hooks?token=${seed.token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'Retry me',
    });
    expect(res.status).toBe(202);
    const { eventId } = (await res.json()) as { eventId: string };

    await waitFor(async () => {
      const rows = await h.deps.db
        .select({ status: deliveries.status })
        .from(deliveries)
        .where(eq(deliveries.eventId, eventId));
      return rows[0]?.status === 'delivered';
    });
    const [row] = await h.deps.db
      .select({ status: deliveries.status, attempts: deliveries.attempts })
      .from(deliveries)
      .where(eq(deliveries.eventId, eventId));
    expect(row).toEqual({ status: 'delivered', attempts: 2 });
    expect(h.fake.sent.at(-1)?.rendered.text).toBe('Retry me');
  });
});
