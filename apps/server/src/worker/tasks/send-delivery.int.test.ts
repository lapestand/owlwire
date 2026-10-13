import { randomBytes } from 'node:crypto';
import { type ChannelAdapter, createFakeAdapter } from '@owlwire/adapter-sdk';
import { FakeClock } from '@owlwire/core';
import { createSecretBox, parseKek } from '@owlwire/crypto';
import { connections, deliveries, destinations } from '@owlwire/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDevWorkspace } from '../../system/dev-seed.js';
import { ingestFor, seedAndIngest } from '../../test/fixtures.js';
import { createHarness, type Harness } from '../../test/harness.js';
import { listJobs } from '../../test/jobs.js';
import { sendJobKey } from '../jobs.js';
import { routeEvent } from './route-event.js';
import { sendDelivery } from './send-delivery.js';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const clock = new FakeClock(NOW);
const webhook = createFakeAdapter('webhook');
const telegram = createFakeAdapter('telegram');
const throwing: ChannelAdapter = {
  ...createFakeAdapter('discord'),
  send: async () => {
    throw new Error('socket hang up');
  },
};
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ clock, adapters: [webhook, telegram, throwing], rand: () => 0.5 });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  clock.set(NOW);
});

async function firstDelivery(eventId: string): Promise<string> {
  const { deliveryIds } = await routeEvent(h.deps, { eventId });
  const id = deliveryIds[0];
  if (!id) throw new Error('expected a delivery');
  return id;
}

async function routed(body = 'Gate opened') {
  const { seed, eventId } = await seedAndIngest(h, {}, { body });
  return { seed, deliveryId: await firstDelivery(eventId) };
}

async function row(id: string) {
  const [r] = await h.deps.db.select().from(deliveries).where(eq(deliveries.id, id));
  if (!r) throw new Error(`delivery ${id} not found`);
  return r;
}

describe('sendDelivery', () => {
  it('delivers through the adapter and records the platform message id', async () => {
    const { deliveryId, seed } = await routed('**Gate** opened');
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('delivered');
    const r = await row(deliveryId);
    expect(r).toMatchObject({ status: 'delivered', attempts: 1, lastError: null });
    expect(r.platformMessageId).toMatch(/^fake-\d+$/);
    expect(r.deliveredAt?.toISOString()).toBe(NOW.toISOString());
    const last = webhook.sent.at(-1);
    expect(last?.rendered.text).toBe('Gate opened');
    expect(last?.dest.id).toBe(seed.destinationId);
  });

  it('skips deliveries that are already final', async () => {
    const { deliveryId } = await routed();
    await sendDelivery(h.deps, { deliveryId });
    const before = webhook.sent.length;
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('skipped');
    expect(webhook.sent.length).toBe(before);
    expect((await row(deliveryId)).attempts).toBe(1);
  });

  it('does not re-send a delivery that has already failed', async () => {
    const { deliveryId } = await routed();
    webhook.nextOutcome({ status: 'permanent', error: 'bad request', destinationBroken: false });
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('failed');
    const before = webhook.sent.length;
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('skipped');
    expect(webhook.sent.length).toBe(before);
    expect(await row(deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'bad request',
    });
  });

  it('schedules a retry with exponential backoff on a transient error', async () => {
    const { deliveryId } = await routed();
    webhook.nextOutcome({ status: 'transient', error: 'boom' });
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('retry_scheduled');
    const r = await row(deliveryId);
    const expected = new Date(NOW.getTime() + 10_000);
    expect(r).toMatchObject({ status: 'scheduled', attempts: 1, lastError: 'boom' });
    expect(r.nextAttemptAt?.toISOString()).toBe(expected.toISOString());
    const jobs = (await listJobs(h.deps.pool)).filter((j) => j.key === sendJobKey(deliveryId));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.run_at.toISOString()).toBe(expected.toISOString());
  });

  it('honours a longer retryAfterMs from a transient error', async () => {
    const { deliveryId } = await routed();
    webhook.nextOutcome({ status: 'transient', error: 'slow', retryAfterMs: 60_000 });
    await sendDelivery(h.deps, { deliveryId });
    expect((await row(deliveryId)).nextAttemptAt?.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it('waits exactly retryAfterMs when rate limited', async () => {
    const { deliveryId } = await routed();
    webhook.nextOutcome({ status: 'rate_limited', retryAfterMs: 30_000 });
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('retry_scheduled');
    const r = await row(deliveryId);
    expect(r.status).toBe('scheduled');
    expect(r.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 30_000);
  });

  it('gives up after the eighth attempt', async () => {
    const { deliveryId } = await routed();
    await h.deps.db.update(deliveries).set({ attempts: 7 }).where(eq(deliveries.id, deliveryId));
    webhook.nextOutcome({ status: 'transient', error: 'still down' });
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('failed');
    const r = await row(deliveryId);
    expect(r).toMatchObject({ status: 'failed', attempts: 8, nextAttemptAt: null });
    expect(r.lastError).toMatch(/giving up after 8 attempts: still down/);
  });

  it('marks the destination broken on a permanent destination error', async () => {
    const { deliveryId, seed } = await routed();
    webhook.nextOutcome({ status: 'permanent', error: 'bot was kicked', destinationBroken: true });
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('failed');
    expect((await row(deliveryId)).lastError).toBe('bot was kicked');
    const [dest] = await h.deps.db
      .select()
      .from(destinations)
      .where(eq(destinations.id, seed.destinationId));
    expect(dest).toMatchObject({ status: 'broken', statusReason: 'send_failed' });
  });

  it('pauses the connection on a ban signal and fails later deliveries without calling the adapter', async () => {
    const { deliveryId, seed } = await routed();
    webhook.nextOutcome({ status: 'banned', error: 'number banned' });
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('failed');
    const [conn] = await h.deps.db
      .select()
      .from(connections)
      .where(eq(connections.id, seed.connectionId));
    expect(conn).toMatchObject({ status: 'paused', statusReason: 'webhook.status.banned' });
    expect((await row(deliveryId)).lastError).toBe('number banned');

    const next = await firstDelivery(await ingestFor(h, seed, { body: 'second' }));
    const before = webhook.sent.length;
    expect(await sendDelivery(h.deps, { deliveryId: next })).toBe('failed');
    expect((await row(next)).lastError).toBe('connection is paused');
    expect(webhook.sent.length).toBe(before);
  });

  it('treats an adapter exception as transient', async () => {
    const { deliveryId, seed } = await routed();
    await h.deps.db
      .update(connections)
      .set({ platform: 'discord' })
      .where(eq(connections.id, seed.connectionId));
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('retry_scheduled');
    expect((await row(deliveryId)).lastError).toBe('socket hang up');
  });

  it('fails when no adapter is registered for the platform', async () => {
    const { deliveryId, seed } = await routed();
    await h.deps.db
      .update(connections)
      .set({ platform: 'whatsapp' })
      .where(eq(connections.id, seed.connectionId));
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('failed');
    expect((await row(deliveryId)).lastError).toMatch(
      /no adapter registered for platform whatsapp/,
    );
  });

  it('fails clearly when connection config cannot be decrypted', async () => {
    const foreignBox = createSecretBox({
      current: parseKek(randomBytes(32).toString('base64'), 9),
      previous: null,
    });
    const seed = await seedDevWorkspace(h.deps.db, foreignBox, clock, {
      platform: 'telegram',
      botToken: '1:abc',
      chatId: '-100',
    });
    const deliveryId = await firstDelivery(await ingestFor(h, seed));
    const before = telegram.sent.length;
    expect(await sendDelivery(h.deps, { deliveryId })).toBe('failed');
    expect((await row(deliveryId)).lastError).toMatch(/could not be decrypted/);
    expect(telegram.sent.length).toBe(before);
  });

  it('skips an unknown delivery id', async () => {
    expect(await sendDelivery(h.deps, { deliveryId: '0192f0f0-0000-7000-8000-000000000000' })).toBe(
      'skipped',
    );
  });
});
