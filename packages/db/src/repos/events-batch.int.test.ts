import { newId } from '@owlwire/core';
import type { Message } from '@owlwire/core/message';
import { issueToken } from '@owlwire/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { type TenantTx, tenantScope, withTenant } from '../scope.js';
import { createApp } from './apps.js';
import { SYSTEM_ACTOR } from './audit.js';
import { getEventStatus, type InsertEventInput, insertEvents } from './events.js';
import { createInstallation } from './installations.js';

let env: DbTestEnv;
let ws: string;
let otherWs: string;

const inWs =
  (id: string) =>
  <T>(fn: (t: TenantTx) => Promise<T>) =>
    withTenant(env.db, tenantScope(id), fn);

beforeAll(async () => {
  env = await setupDbTestEnv();
  ws = await createTestWorkspace(env.db, 'alpha');
  otherWs = await createTestWorkspace(env.db, 'bravo');
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

async function installation(workspaceId: string): Promise<string> {
  const issued = issueToken('inst');
  return inWs(workspaceId)(async (t) => {
    const app = await createApp(
      t,
      { name: 'App', slug: `app-${newId().slice(-12)}`, visibility: 'private' },
      SYSTEM_ACTOR,
    );
    const inst = await createInstallation(
      t,
      { appId: app.id, tokenHash: issued.hash, tokenPrefix: issued.prefix },
      SYSTEM_ACTOR,
    );
    return inst.id;
  });
}

function row(installationId: string, idempotencyKey: string): InsertEventInput {
  const message: Message = { type: 'generic', severity: 'info', body: 'hello' };
  return { installationId, idempotencyKey, type: 'generic', severity: 'info', message };
}

/** Reads Graphile Worker's private tables (payload and queue are not exposed by the public view). */
async function routeJobs(eventId: string): Promise<Array<{ queue_name: string | null }>> {
  const { rows } = await env.owner.query<{ queue_name: string | null }>(
    `select q.queue_name
     from graphile_worker._private_jobs j
     join graphile_worker._private_tasks t on t.id = j.task_id
     left join graphile_worker._private_job_queues q on q.id = j.job_queue_id
     where t.identifier = 'route_event' and j.payload->>'eventId' = $1`,
    [eventId],
  );
  return rows;
}

describe('insertEvents', () => {
  it('stores a new event and enqueues exactly one route_event job on the installation queue', async () => {
    const inst = await installation(ws);
    const [r] = await inWs(ws)((t) => insertEvents(t, [row(inst, 'k1')]));
    expect(r?.duplicate).toBe(false);
    expect(await routeJobs(r?.eventId as string)).toEqual([
      { queue_name: `w:${ws}:route:${inst}` },
    ]);
  });

  it('returns the original event id for a repeated idempotency key', async () => {
    const inst = await installation(ws);
    const [a] = await inWs(ws)((t) => insertEvents(t, [row(inst, 'same')]));
    const [b] = await inWs(ws)((t) => insertEvents(t, [row(inst, 'same')]));
    expect(b).toEqual({ eventId: a?.eventId, duplicate: true });
    expect(await routeJobs(a?.eventId as string)).toHaveLength(1);
  });

  it('deduplicates a repeated key inside one batch', async () => {
    const inst = await installation(ws);
    const res = await inWs(ws)((t) =>
      insertEvents(t, [row(inst, 'dup'), row(inst, 'other'), row(inst, 'dup')]),
    );
    expect(res.map((r) => r.duplicate)).toEqual([false, false, true]);
    expect(res[2]?.eventId).toBe(res[0]?.eventId);
  });

  it('keeps idempotency keys independent per installation', async () => {
    const i1 = await installation(ws);
    const i2 = await installation(ws);
    const [a] = await inWs(ws)((t) => insertEvents(t, [row(i1, 'shared')]));
    const [b] = await inWs(ws)((t) => insertEvents(t, [row(i2, 'shared')]));
    expect(a?.duplicate).toBe(false);
    expect(b?.duplicate).toBe(false);
    expect(a?.eventId).not.toBe(b?.eventId);
  });

  it('handles concurrent inserts with the same key without errors', async () => {
    const inst = await installation(ws);
    const [a, b] = await Promise.all([
      inWs(ws)((t) => insertEvents(t, [row(inst, 'race')])),
      inWs(ws)((t) => insertEvents(t, [row(inst, 'race')])),
    ]);
    expect(a[0]?.eventId).toBe(b[0]?.eventId);
    expect([a[0]?.duplicate, b[0]?.duplicate].sort()).toEqual([false, true]);
    expect(await routeJobs(a[0]?.eventId as string)).toHaveLength(1);
  });
});

describe('getEventStatus', () => {
  it('summarises deliveries and routing state', async () => {
    const inst = await installation(ws);
    const [ev] = await inWs(ws)((t) => insertEvents(t, [row(inst, 'status')]));
    const eventId = ev?.eventId as string;
    expect(await inWs(ws)((t) => getEventStatus(t, inst, eventId))).toEqual({
      id: eventId,
      status: 'received',
      deliveries: { total: 0, delivered: 0, failed: 0, pending: 0 },
    });

    const connectionId = newId();
    await env.owner.query(
      `insert into connections (id, workspace_id, platform, kind, display_name, status)
       values ($1, $2, 'webhook', 'webhook', 'hook', 'active')`,
      [connectionId, ws],
    );
    const statuses = ['delivered', 'digested', 'failed', 'scheduled', 'suppressed'];
    for (const [i, status] of statuses.entries()) {
      const destinationId = newId();
      await env.owner.query(
        `insert into destinations (id, workspace_id, connection_id, kind, external_id, name)
         values ($1, $2, $3, 'webhook', $4, 'd')`,
        [destinationId, ws, connectionId, `ext-${eventId}-${i}`],
      );
      await env.owner.query(
        `insert into deliveries (id, workspace_id, event_id, destination_id, connection_id, status)
         values ($1, $2, $3, $4, $5, $6)`,
        [newId(), ws, eventId, destinationId, connectionId, status],
      );
    }
    await env.owner.query(`update events set routed_at = now() where id = $1`, [eventId]);

    expect(await inWs(ws)((t) => getEventStatus(t, inst, eventId))).toEqual({
      id: eventId,
      status: 'routed',
      deliveries: { total: 5, delivered: 2, failed: 1, pending: 1 },
    });
  });

  it('hides events of other installations and other workspaces', async () => {
    const inst = await installation(ws);
    const other = await installation(ws);
    const [ev] = await inWs(ws)((t) => insertEvents(t, [row(inst, 'hidden')]));
    const eventId = ev?.eventId as string;
    expect(await inWs(ws)((t) => getEventStatus(t, other, eventId))).toBeNull();
    expect(await inWs(otherWs)((t) => getEventStatus(t, inst, eventId))).toBeNull();
  });
});
