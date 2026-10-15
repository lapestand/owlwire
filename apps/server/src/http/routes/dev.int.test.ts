import type { DevDeliveryList } from '@owlwire/contracts';
import { FakeClock } from '@owlwire/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DEV_ADMIN_TOKEN } from '../../test/config.js';
import { ingestFor, seedAndIngest } from '../../test/fixtures.js';
import { createHarness, type Harness } from '../../test/harness.js';
import { routeEvent } from '../../worker/tasks/route-event.js';
import { sendDelivery } from '../../worker/tasks/send-delivery.js';
import { createApp } from '../app.js';

const START = new Date('2026-10-12T10:00:00.000Z');
const clock = new FakeClock(START);
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ clock });
});
afterAll(async () => {
  await h.close();
});

// The endpoint lists deliveries of every workspace, so each test starts from an empty database at the start
// time and routes its own events; the tests then pass in any order.
beforeEach(async () => {
  await h.ownerPool.query('truncate workspaces, audit_log cascade');
  clock.set(START);
});

function list(query = '', token = TEST_DEV_ADMIN_TOKEN) {
  return h.app.request(`/api/dev/deliveries${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe('GET /api/dev/deliveries', () => {
  it('lists deliveries newest first with event and destination details', async () => {
    const { seed, eventId: first } = await seedAndIngest(h, {}, { title: 'First', body: 'one' });
    const { deliveryIds } = await routeEvent(h.deps, { eventId: first, _ws: seed.workspaceId });
    await sendDelivery(h.deps, { deliveryId: deliveryIds[0] ?? '', _ws: seed.workspaceId });
    clock.advance(60_000);
    const second = await ingestFor(h, seed, { type: 'attack.incoming', body: 'two' });
    await routeEvent(h.deps, { eventId: second, _ws: seed.workspaceId });

    const res = await list();
    expect(res.status).toBe(200);
    const body = (await res.json()) as DevDeliveryList;
    expect(body.deliveries[0]).toMatchObject({
      eventId: second,
      eventType: 'attack.incoming',
      eventTitle: null,
      status: 'pending',
      attempts: 0,
      platform: 'webhook',
      destinationName: expect.stringMatching(/^webhook:/),
      deliveredAt: null,
    });
    expect(body.deliveries[1]).toMatchObject({
      eventId: first,
      eventTitle: 'First',
      status: 'delivered',
      attempts: 1,
      lastError: null,
      createdAt: '2026-10-12T10:00:00.000Z',
      deliveredAt: '2026-10-12T10:00:00.000Z',
    });
  });

  it('honours the limit parameter and ignores garbage', async () => {
    const { seed, eventId: first } = await seedAndIngest(h, {}, { body: 'one' });
    await routeEvent(h.deps, { eventId: first, _ws: seed.workspaceId });
    clock.advance(60_000);
    const second = await ingestFor(h, seed, { body: 'two' });
    await routeEvent(h.deps, { eventId: second, _ws: seed.workspaceId });
    expect(((await (await list()).json()) as DevDeliveryList).deliveries).toHaveLength(2);
    expect(((await (await list('?limit=1')).json()) as DevDeliveryList).deliveries).toHaveLength(1);
    expect((await list('?limit=abc')).status).toBe(200);
  });

  it('rejects a missing or wrong token', async () => {
    expect((await list('', 'wrong-token-wrong-token')).status).toBe(401);
    const res = await h.app.request('/api/dev/deliveries');
    expect(res.status).toBe(401);
  });

  it('does not exist when no dev admin token is configured', async () => {
    const app = createApp({
      ...h.deps,
      config: { ...h.deps.config, devAdminToken: null },
      webDir: null,
    });
    const res = await app.request('/api/dev/deliveries', {
      headers: { authorization: `Bearer ${TEST_DEV_ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});
