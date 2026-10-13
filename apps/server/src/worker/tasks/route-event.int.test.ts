import { FakeClock, newId } from '@owlwire/core';
import { deliveries, destinations, events, rules, ruleTargets } from '@owlwire/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedAndIngest } from '../../test/fixtures.js';
import { createHarness, type Harness } from '../../test/harness.js';
import { listJobs } from '../../test/jobs.js';
import { routeEvent } from './route-event.js';

const NOW = new Date('2026-10-12T10:00:00.000Z');
const clock = new FakeClock(NOW);
let h: Harness;

beforeAll(async () => {
  h = await createHarness({ clock });
});
afterAll(async () => {
  await h.close();
});

async function deliveriesOf(eventId: string) {
  return h.deps.db.select().from(deliveries).where(eq(deliveries.eventId, eventId));
}

describe('routeEvent', () => {
  it('creates a pending delivery and a send job on the connection queue', async () => {
    const { seed, eventId } = await seedAndIngest(h);
    const { deliveryIds } = await routeEvent(h.deps, { eventId });
    expect(deliveryIds).toHaveLength(1);

    const [row] = await deliveriesOf(eventId);
    expect(row).toMatchObject({
      id: deliveryIds[0],
      status: 'pending',
      attempts: 0,
      workspaceId: seed.workspaceId,
      destinationId: seed.destinationId,
      connectionId: seed.connectionId,
    });

    const jobs = (await listJobs(h.deps.pool)).filter((j) => j.key === `send:${deliveryIds[0]}`);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      task: 'send_delivery',
      queue_name: `conn:${seed.connectionId}`,
      payload: { deliveryId: deliveryIds[0] },
    });
    expect(jobs[0]?.run_at.toISOString()).toBe(NOW.toISOString());

    const [ev] = await h.deps.db.select().from(events).where(eq(events.id, eventId));
    expect(ev?.routedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('is idempotent when the job runs twice', async () => {
    const { eventId } = await seedAndIngest(h);
    await routeEvent(h.deps, { eventId });
    const again = await routeEvent(h.deps, { eventId });
    expect(again.deliveryIds).toEqual([]);
    const rows = await deliveriesOf(eventId);
    expect(rows).toHaveLength(1);
    const jobs = (await listJobs(h.deps.pool)).filter((j) => j.key === `send:${rows[0]?.id}`);
    expect(jobs).toHaveLength(1);
  });

  it('routes exact type matches and skips other types', async () => {
    const match = await seedAndIngest(h, { types: ['player.inactive'] });
    expect((await routeEvent(h.deps, { eventId: match.eventId })).deliveryIds).toHaveLength(1);
    const miss = await seedAndIngest(h, { types: ['attack.incoming'] });
    expect((await routeEvent(h.deps, { eventId: miss.eventId })).deliveryIds).toEqual([]);
    const [ev] = await h.deps.db.select().from(events).where(eq(events.id, miss.eventId));
    expect(ev?.routedAt).toBeInstanceOf(Date);
  });

  it('skips disabled rules and rules above the event severity', async () => {
    const disabled = await seedAndIngest(h);
    await h.deps.db.update(rules).set({ enabled: false }).where(eq(rules.id, disabled.seed.ruleId));
    expect((await routeEvent(h.deps, { eventId: disabled.eventId })).deliveryIds).toEqual([]);

    const strict = await seedAndIngest(h, {}, { severity: 'medium' });
    await h.deps.db
      .update(rules)
      .set({ minSeverity: 'high' })
      .where(eq(rules.id, strict.seed.ruleId));
    expect((await routeEvent(h.deps, { eventId: strict.eventId })).deliveryIds).toEqual([]);
  });

  it('ignores destinations without confirmed consent or marked broken', async () => {
    const pending = await seedAndIngest(h);
    await h.deps.db
      .update(destinations)
      .set({ consentStatus: 'pending' })
      .where(eq(destinations.id, pending.seed.destinationId));
    expect((await routeEvent(h.deps, { eventId: pending.eventId })).deliveryIds).toEqual([]);

    const broken = await seedAndIngest(h);
    await h.deps.db
      .update(destinations)
      .set({ status: 'broken' })
      .where(eq(destinations.id, broken.seed.destinationId));
    expect((await routeEvent(h.deps, { eventId: broken.eventId })).deliveryIds).toEqual([]);
  });

  it('never routes to a destination that belongs to another workspace', async () => {
    const a = await seedAndIngest(h);
    const b = await seedAndIngest(h);
    await h.deps.db.delete(ruleTargets).where(eq(ruleTargets.ruleId, a.seed.ruleId));
    // P1a: rule_targets_destination_ws_fk bileşik FK'si kiracılar arası hedefi şema düzeyinde reddeder.
    await expect(
      h.deps.db.insert(ruleTargets).values({
        id: newId(),
        workspaceId: a.seed.workspaceId,
        ruleId: a.seed.ruleId,
        destinationId: b.seed.destinationId,
      }),
    ).rejects.toMatchObject({
      cause: { code: '23503', constraint: 'rule_targets_destination_ws_fk' },
    });
    expect((await routeEvent(h.deps, { eventId: a.eventId })).deliveryIds).toEqual([]);
  });

  it('tolerates an unknown event id', async () => {
    expect(await routeEvent(h.deps, { eventId: newId() })).toEqual({ deliveryIds: [] });
  });
});
