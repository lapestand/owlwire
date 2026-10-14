import { type ChannelAdapter, createFakeAdapter } from '@owlwire/adapter-sdk';
import { FakeClock } from '@owlwire/core';
import {
  connectionQueue,
  enqueueJob,
  sendJobKey,
  tenantJobName,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../../logger.js';
import { seedDevWorkspace } from '../../system/dev-seed.js';
import { ingestFor, seedAndIngest } from '../../test/fixtures.js';
import { createHarness, type Harness } from '../../test/harness.js';
import { listJobs } from '../../test/jobs.js';
import { createTaskList } from '../runner.js';
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

async function jobPayload(task: string, idKey: string, id: string) {
  const job = (await listJobs(h.ownerPool)).find((j) => j.task === task && j.payload[idKey] === id);
  if (!job) throw new Error(`no ${task} job for ${id}`);
  return job.payload;
}

async function firstDelivery(eventId: string): Promise<string> {
  const payload = await jobPayload('route_event', 'eventId', eventId);
  const { deliveryIds } = await routeEvent(h.deps, payload as { eventId: string });
  const id = deliveryIds[0];
  if (!id) throw new Error('expected a delivery');
  return id;
}

/** Runs send_delivery with the payload exactly as it was enqueued (with the `_ws` stamp). */
async function send(deliveryId: string) {
  const payload = await jobPayload('send_delivery', 'deliveryId', deliveryId);
  return sendDelivery(h.deps, payload as { deliveryId: string });
}

async function routed(body = 'Gate opened') {
  const { seed, eventId } = await seedAndIngest(h, {}, { body });
  return { seed, deliveryId: await firstDelivery(eventId) };
}

/** Assertions and raw fixtures through the owner pool (outside RLS). */
async function row(id: string) {
  const { rows } = await h.ownerPool.query<{
    status: string;
    attempts: number;
    lastError: string | null;
    platformMessageId: string | null;
    deliveredAt: Date | null;
    nextAttemptAt: Date | null;
  }>(
    `select status, attempts, last_error as "lastError", platform_message_id as "platformMessageId",
            delivered_at as "deliveredAt", next_attempt_at as "nextAttemptAt"
     from deliveries where id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new Error(`delivery ${id} not found`);
  return r;
}

function capturingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger('warn', {
    write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('sendDelivery', () => {
  it('delivers through the adapter and records the platform message id', async () => {
    const { deliveryId, seed } = await routed('**Gate** opened');
    expect(await send(deliveryId)).toBe('delivered');
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
    await send(deliveryId);
    const before = webhook.sent.length;
    expect(await send(deliveryId)).toBe('skipped');
    expect(webhook.sent.length).toBe(before);
    expect((await row(deliveryId)).attempts).toBe(1);
  });

  it('does not re-send a delivery that has already failed', async () => {
    const { deliveryId } = await routed();
    webhook.nextOutcome({ status: 'permanent', error: 'bad request', destinationBroken: false });
    expect(await send(deliveryId)).toBe('failed');
    const before = webhook.sent.length;
    expect(await send(deliveryId)).toBe('skipped');
    expect(webhook.sent.length).toBe(before);
    expect(await row(deliveryId)).toMatchObject({
      status: 'failed',
      attempts: 1,
      lastError: 'bad request',
    });
  });

  it('schedules a retry with exponential backoff on a transient error', async () => {
    const { deliveryId, seed } = await routed();
    webhook.nextOutcome({ status: 'transient', error: 'boom' });
    expect(await send(deliveryId)).toBe('retry_scheduled');
    const r = await row(deliveryId);
    const expected = new Date(NOW.getTime() + 10_000);
    expect(r).toMatchObject({ status: 'scheduled', attempts: 1, lastError: 'boom' });
    expect(r.nextAttemptAt?.toISOString()).toBe(expected.toISOString());
    const key = tenantJobName(seed.workspaceId, sendJobKey(deliveryId));
    const jobs = (await listJobs(h.ownerPool)).filter((j) => j.key === key);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.run_at.toISOString()).toBe(expected.toISOString());
    expect(jobs[0]?.queue_name).toBe(
      tenantJobName(seed.workspaceId, connectionQueue(seed.connectionId)),
    );
    expect(jobs[0]?.payload).toEqual({ deliveryId, _ws: seed.workspaceId });
  });

  it('honours a longer retryAfterMs from a transient error', async () => {
    const { deliveryId } = await routed();
    webhook.nextOutcome({ status: 'transient', error: 'slow', retryAfterMs: 60_000 });
    await send(deliveryId);
    expect((await row(deliveryId)).nextAttemptAt?.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it('waits exactly retryAfterMs when rate limited', async () => {
    const { deliveryId } = await routed();
    webhook.nextOutcome({ status: 'rate_limited', retryAfterMs: 30_000 });
    expect(await send(deliveryId)).toBe('retry_scheduled');
    const r = await row(deliveryId);
    expect(r.status).toBe('scheduled');
    expect(r.nextAttemptAt?.getTime()).toBe(NOW.getTime() + 30_000);
  });

  it('gives up after the eighth attempt', async () => {
    const { deliveryId } = await routed();
    await h.ownerPool.query('update deliveries set attempts = 7 where id = $1', [deliveryId]);
    webhook.nextOutcome({ status: 'transient', error: 'still down' });
    expect(await send(deliveryId)).toBe('failed');
    const r = await row(deliveryId);
    expect(r).toMatchObject({ status: 'failed', attempts: 8, nextAttemptAt: null });
    expect(r.lastError).toMatch(/giving up after 8 attempts: still down/);
  });

  it('marks the destination broken on a permanent destination error', async () => {
    const { deliveryId, seed } = await routed();
    webhook.nextOutcome({ status: 'permanent', error: 'bot was kicked', destinationBroken: true });
    expect(await send(deliveryId)).toBe('failed');
    expect((await row(deliveryId)).lastError).toBe('bot was kicked');
    const dest = (
      await h.ownerPool.query(
        'select status, status_reason as "statusReason" from destinations where id = $1',
        [seed.destinationId],
      )
    ).rows[0];
    expect(dest).toMatchObject({ status: 'broken', statusReason: 'send_failed' });
  });

  it('pauses the connection on a ban signal and fails later deliveries without calling the adapter', async () => {
    const { deliveryId, seed } = await routed();
    webhook.nextOutcome({ status: 'banned', error: 'number banned' });
    expect(await send(deliveryId)).toBe('failed');
    const conn = (
      await h.ownerPool.query(
        'select status, status_reason as "statusReason" from connections where id = $1',
        [seed.connectionId],
      )
    ).rows[0];
    expect(conn).toMatchObject({ status: 'paused', statusReason: 'webhook.status.banned' });
    expect((await row(deliveryId)).lastError).toBe('number banned');

    const next = await firstDelivery(await ingestFor(h, seed, { body: 'second' }));
    const before = webhook.sent.length;
    expect(await send(next)).toBe('failed');
    expect((await row(next)).lastError).toBe('connection is paused');
    expect(webhook.sent.length).toBe(before);
  });

  it('treats an adapter exception as transient', async () => {
    const { deliveryId, seed } = await routed();
    await h.ownerPool.query('update connections set platform = $2 where id = $1', [
      seed.connectionId,
      'discord',
    ]);
    expect(await send(deliveryId)).toBe('retry_scheduled');
    expect((await row(deliveryId)).lastError).toBe('socket hang up');
  });

  it('fails when no adapter is registered for the platform', async () => {
    const { deliveryId, seed } = await routed();
    await h.ownerPool.query('update connections set platform = $2 where id = $1', [
      seed.connectionId,
      'whatsapp',
    ]);
    expect(await send(deliveryId)).toBe('failed');
    expect((await row(deliveryId)).lastError).toMatch(
      /no adapter registered for platform whatsapp/,
    );
  });

  it('fails clearly when connection config cannot be decrypted', async () => {
    const seed = await seedDevWorkspace(h.deps.db, {
      platform: 'telegram',
      botToken: '1:abc',
      chatId: '-100',
    });
    const other = await seedDevWorkspace(h.deps.db, {
      platform: 'telegram',
      botToken: '2:def',
      chatId: '-200',
    });
    // Through the owner pool: another workspace's ciphertext (other DEK, other AAD) is copied onto this connection.
    await h.ownerPool.query(
      'update connections set config_enc = (select config_enc from connections where id = $2) where id = $1',
      [seed.connectionId, other.connectionId],
    );
    const deliveryId = await firstDelivery(await ingestFor(h, seed));
    const before = telegram.sent.length;
    expect(await send(deliveryId)).toBe('failed');
    expect((await row(deliveryId)).lastError).toMatch(/could not be decrypted/);
    expect(telegram.sent.length).toBe(before);
  });

  it('keeps the delivery retryable when loading its context fails for a non-crypto reason', async () => {
    const { deliveryId } = await routed('transient load');
    const payload = await jobPayload('send_delivery', 'deliveryId', deliveryId);
    const task = createTaskList(h.deps).send_delivery;
    const helpers = { job: { id: '1' } } as Parameters<NonNullable<typeof task>>[1];
    const before = webhook.sent.length;
    // A database error while loading the context (here: permission denied on destinations) is not a key problem.
    await h.ownerPool.query('revoke select on destinations from owlwire_app');
    try {
      await expect(sendDelivery(h.deps, payload as { deliveryId: string })).rejects.toThrow();
      // Through the task list the error reaches Graphile, which retries the job; the message is sanitised.
      const err = await Promise.resolve(task?.(payload, helpers)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/Failed query/);
      expect((err as Error).message).not.toMatch(/params:/);
    } finally {
      await h.ownerPool.query('grant select on destinations to owlwire_app');
    }
    const r = await row(deliveryId);
    expect(r.status).not.toBe('failed');
    expect(r).toMatchObject({ status: 'sending', attempts: 2, lastError: null });
    expect(webhook.sent.length).toBe(before);
    // The retry delivers.
    expect(await send(deliveryId)).toBe('delivered');
    expect(await row(deliveryId)).toMatchObject({ status: 'delivered', attempts: 3 });
  });

  it('drops a forged job: another workspace enqueued this delivery id in its own namespace', async () => {
    const victim = await routed('victim');
    const attacker = await seedAndIngest(h);
    await withTenant(h.deps.db, tenantScope(attacker.seed.workspaceId), (t) =>
      enqueueJob(
        t,
        'send_delivery',
        { deliveryId: victim.deliveryId },
        { queueName: connectionQueue(attacker.seed.connectionId) },
      ),
    );
    const forged = (await listJobs(h.ownerPool)).find(
      (j) =>
        j.task === 'send_delivery' &&
        j.payload.deliveryId === victim.deliveryId &&
        j.payload._ws === attacker.seed.workspaceId,
    );
    expect(forged).toBeDefined();
    const before = webhook.sent.length;
    const { logger, lines } = capturingLogger();
    expect(
      await sendDelivery({ ...h.deps, logger }, forged?.payload as { deliveryId: string }),
    ).toBe('skipped');
    expect(webhook.sent.length).toBe(before);
    expect(await row(victim.deliveryId)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      deliveryId: victim.deliveryId,
      workspaceId: victim.seed.workspaceId,
      jobWorkspaceId: attacker.seed.workspaceId,
    });
    // The genuine job still delivers.
    expect(await send(victim.deliveryId)).toBe('delivered');
  });

  it('drops a job without the workspace stamp instead of throwing', async () => {
    const { deliveryId } = await routed();
    const before = webhook.sent.length;
    const { logger, lines } = capturingLogger();
    await expect(sendDelivery({ ...h.deps, logger }, { deliveryId })).resolves.toBe('skipped');
    expect(webhook.sent.length).toBe(before);
    expect(await row(deliveryId)).toMatchObject({ status: 'pending', attempts: 0 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ deliveryId, jobWorkspaceId: null });
  });

  it('skips an unknown delivery id', async () => {
    expect(
      await sendDelivery(h.deps, { deliveryId: '0192f0f0-0000-7000-8000-000000000000', _ws: null }),
    ).toBe('skipped');
  });
});
