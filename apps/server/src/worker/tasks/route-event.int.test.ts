import { FakeClock, newId } from '@owlwire/core';
import {
  connectionQueue,
  enqueueJob,
  routeQueue,
  sendJobKey,
  tenantJobName,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../logger.js';
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

/** R43: assertions through the owner pool (outside RLS). */
async function deliveriesOf(eventId: string) {
  const { rows } = await h.ownerPool.query<{
    id: string;
    status: string;
    attempts: number;
    workspaceId: string;
    destinationId: string;
    connectionId: string;
  }>(
    `select id, status, attempts, workspace_id as "workspaceId", destination_id as "destinationId",
            connection_id as "connectionId"
     from deliveries where event_id = $1`,
    [eventId],
  );
  return rows;
}

async function routedAt(eventId: string): Promise<Date | null | undefined> {
  const { rows } = await h.ownerPool.query<{ routed_at: Date | null }>(
    'select routed_at from events where id = $1',
    [eventId],
  );
  return rows[0]?.routed_at;
}

/** The payload exactly as ingest enqueued it (with the `_ws` stamp). */
async function routePayload(eventId: string) {
  const job = (await listJobs(h.ownerPool)).find(
    (j) => j.task === 'route_event' && j.payload.eventId === eventId,
  );
  if (!job) throw new Error(`no route_event job for ${eventId}`);
  return job.payload as { eventId: string; _ws?: unknown };
}

async function route(eventId: string) {
  return routeEvent(h.deps, await routePayload(eventId));
}

function capturingLogger() {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger('warn', {
    write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

describe('routeEvent', () => {
  it('creates a pending delivery and a send job on the namespaced connection queue', async () => {
    const { seed, eventId } = await seedAndIngest(h);
    const { deliveryIds } = await route(eventId);
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

    const key = tenantJobName(seed.workspaceId, sendJobKey(deliveryIds[0] ?? ''));
    const jobs = (await listJobs(h.ownerPool)).filter((j) => j.key === key);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      task: 'send_delivery',
      queue_name: tenantJobName(seed.workspaceId, connectionQueue(seed.connectionId)),
      payload: { deliveryId: deliveryIds[0], _ws: seed.workspaceId },
    });
    expect(jobs[0]?.run_at.toISOString()).toBe(NOW.toISOString());
    expect((await routedAt(eventId))?.toISOString()).toBe(NOW.toISOString());
  });

  it('is idempotent when the job runs twice', async () => {
    const { seed, eventId } = await seedAndIngest(h);
    await route(eventId);
    const again = await route(eventId);
    expect(again.deliveryIds).toEqual([]);
    const rows = await deliveriesOf(eventId);
    expect(rows).toHaveLength(1);
    const key = tenantJobName(seed.workspaceId, sendJobKey(rows[0]?.id ?? ''));
    expect((await listJobs(h.ownerPool)).filter((j) => j.key === key)).toHaveLength(1);
  });

  it('routes exact type matches and skips other types', async () => {
    const match = await seedAndIngest(h, { types: ['player.inactive'] });
    expect((await route(match.eventId)).deliveryIds).toHaveLength(1);
    const miss = await seedAndIngest(h, { types: ['attack.incoming'] });
    expect((await route(miss.eventId)).deliveryIds).toEqual([]);
    expect(await routedAt(miss.eventId)).toBeInstanceOf(Date);
  });

  it('skips disabled rules and rules above the event severity', async () => {
    const disabled = await seedAndIngest(h);
    await h.ownerPool.query('update rules set enabled = false where id = $1', [
      disabled.seed.ruleId,
    ]);
    expect((await route(disabled.eventId)).deliveryIds).toEqual([]);

    const strict = await seedAndIngest(h, {}, { severity: 'medium' });
    await h.ownerPool.query("update rules set min_severity = 'high' where id = $1", [
      strict.seed.ruleId,
    ]);
    expect((await route(strict.eventId)).deliveryIds).toEqual([]);
  });

  it('ignores destinations without confirmed consent or marked broken', async () => {
    const pending = await seedAndIngest(h);
    await h.ownerPool.query("update destinations set consent_status = 'pending' where id = $1", [
      pending.seed.destinationId,
    ]);
    expect((await route(pending.eventId)).deliveryIds).toEqual([]);

    const broken = await seedAndIngest(h);
    await h.ownerPool.query("update destinations set status = 'broken' where id = $1", [
      broken.seed.destinationId,
    ]);
    expect((await route(broken.eventId)).deliveryIds).toEqual([]);
  });

  it('never routes to a destination that belongs to another workspace', async () => {
    const a = await seedAndIngest(h);
    const b = await seedAndIngest(h);
    await h.ownerPool.query('delete from rule_targets where rule_id = $1', [a.seed.ruleId]);
    // P1a: the composite rule_targets_destination_ws_fk rejects a cross-tenant target at schema level.
    await expect(
      h.ownerPool.query(
        'insert into rule_targets (id, workspace_id, rule_id, destination_id) values ($1, $2, $3, $4)',
        [newId(), a.seed.workspaceId, a.seed.ruleId, b.seed.destinationId],
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'rule_targets_destination_ws_fk' });
    expect((await route(a.eventId)).deliveryIds).toEqual([]);
  });

  it('tolerates an unknown event id', async () => {
    expect(await routeEvent(h.deps, { eventId: newId(), _ws: newId() })).toEqual({
      deliveryIds: [],
    });
  });

  it('drops a forged job: another workspace enqueued this event id in its own namespace', async () => {
    const victim = await seedAndIngest(h);
    const attacker = await seedAndIngest(h);
    await withTenant(h.deps.db, tenantScope(attacker.seed.workspaceId), (t) =>
      enqueueJob(
        t,
        'route_event',
        { eventId: victim.eventId },
        { queueName: routeQueue(attacker.seed.installationId) },
      ),
    );
    const forged = (await listJobs(h.ownerPool)).find(
      (j) =>
        j.task === 'route_event' &&
        j.payload.eventId === victim.eventId &&
        j.payload._ws === attacker.seed.workspaceId,
    );
    expect(forged).toBeDefined();
    const { logger, lines } = capturingLogger();
    expect(await routeEvent({ ...h.deps, logger }, forged?.payload as { eventId: string })).toEqual(
      { deliveryIds: [] },
    );
    expect(await routedAt(victim.eventId)).toBeNull();
    expect(await deliveriesOf(victim.eventId)).toEqual([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      eventId: victim.eventId,
      workspaceId: victim.seed.workspaceId,
      jobWorkspaceId: attacker.seed.workspaceId,
    });
    expect(String(lines[0]?.msg)).toMatch(/does not match/);
    // The genuine job still routes.
    expect((await route(victim.eventId)).deliveryIds).toHaveLength(1);
  });

  it('drops a job without the workspace stamp instead of throwing', async () => {
    const { eventId } = await seedAndIngest(h);
    const { logger, lines } = capturingLogger();
    await expect(routeEvent({ ...h.deps, logger }, { eventId })).resolves.toEqual({
      deliveryIds: [],
    });
    expect(await routedAt(eventId)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ eventId, jobWorkspaceId: null });
  });
});
