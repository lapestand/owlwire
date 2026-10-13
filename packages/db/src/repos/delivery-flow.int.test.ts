import { randomUUID } from 'node:crypto';
import { newId } from '@owlwire/core';
import type { Message } from '@owlwire/core/message';
import { listQueuedJobs } from '@owlwire/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { RepoInputError, RepoNotFoundError } from '../errors.js';
import { SYSTEM, type TenantTx, tenantScope, withSystem, withTenant } from '../scope.js';
import { createApp } from './apps.js';
import { createAudience } from './audiences.js';
import { listAuditLog, SYSTEM_ACTOR } from './audit.js';
import { createConnection, deleteConnection } from './connections.js';
import {
  createDeliveries,
  getDelivery,
  listDeliveries,
  loadDeliveryContext,
  updateDelivery,
} from './deliveries.js';
import { createDestination } from './destinations.js';
import { getEvent, insertEvent, markEventRouted } from './events.js';
import { createInstallation, revokeInstallation } from './installations.js';
import { enqueueJob, healthJobKey } from './jobs.js';
import {
  createRule,
  deleteRule,
  listRules,
  listRulesForInstallation,
  updateRule,
} from './rules.js';

interface Graph {
  ws: string;
  connectionId: string;
  destinationId: string;
  installationId: string;
}

let env: DbTestEnv;
let a: Graph;
let b: Graph;

const msg: Message = { type: 'generic', severity: 'info', body: 'hello' };
const inWs = <T>(ws: string, fn: (t: TenantTx) => Promise<T>) =>
  withTenant(env.db, tenantScope(ws), fn);

async function buildGraph(label: string): Promise<Graph> {
  const ws = await createTestWorkspace(env.db, label);
  return inWs(ws, async (t) => {
    const conn = await createConnection(
      t,
      {
        platform: 'telegram',
        kind: 'own_bot',
        displayName: 'bot',
        config: { botToken: `${label}-token` },
      },
      SYSTEM_ACTOR,
    );
    const dest = await createDestination(t, {
      connectionId: conn.id,
      kind: 'group',
      externalId: `-100${label}`,
      name: label,
      consentStatus: 'confirmed',
    });
    const app = await createApp(
      t,
      { name: label, slug: `${label}-${randomUUID()}`, visibility: 'private' },
      SYSTEM_ACTOR,
    );
    const inst = await createInstallation(
      t,
      { appId: app.id, tokenHash: randomUUID(), tokenPrefix: 'ow_inst_test' },
      SYSTEM_ACTOR,
    );
    return { ws, connectionId: conn.id, destinationId: dest.id, installationId: inst.id };
  });
}

/** A second live connection with one destination in the given workspace. */
async function extraDestination(
  ws: string,
  label: string,
): Promise<{ connectionId: string; destinationId: string }> {
  return inWs(ws, async (t) => {
    const conn = await createConnection(
      t,
      { platform: 'telegram', kind: 'own_bot', displayName: label, config: null },
      SYSTEM_ACTOR,
    );
    const dest = await createDestination(t, {
      connectionId: conn.id,
      kind: 'group',
      externalId: `-200${label}-${randomUUID()}`,
      name: label,
      consentStatus: 'confirmed',
    });
    return { connectionId: conn.id, destinationId: dest.id };
  });
}

async function jobCount(task: string, key: string, value: string): Promise<number> {
  return (await listQueuedJobs(env.owner)).filter(
    (j) => j.task === task && j.payload[key] === value,
  ).length;
}

const newEvent = (g: Graph) =>
  inWs(g.ws, (t) =>
    insertEvent(t, {
      installationId: g.installationId,
      idempotencyKey: randomUUID(),
      type: 'generic',
      severity: 'info',
      message: msg,
    }),
  );

beforeAll(async () => {
  env = await setupDbTestEnv();
  a = await buildGraph('alpha');
  b = await buildGraph('bravo');
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

describe('rules', () => {
  it('creates rules with destination and audience targets and lists enabled ones per installation', async () => {
    const aud = await inWs(a.ws, (t) =>
      createAudience(t, { name: `aud-${randomUUID()}` }, SYSTEM_ACTOR),
    );
    const rule = await inWs(a.ws, (t) =>
      createRule(
        t,
        {
          installationId: a.installationId,
          name: 'all',
          types: ['*'],
          targets: [{ destinationId: a.destinationId }, { audienceId: aud.id }],
        },
        SYSTEM_ACTOR,
      ),
    );
    expect(rule.minSeverity).toBe('info');
    expect(rule.targets).toEqual(
      expect.arrayContaining([{ destinationId: a.destinationId }, { audienceId: aud.id }]),
    );
    await inWs(a.ws, (t) =>
      createRule(
        t,
        {
          installationId: a.installationId,
          name: 'off',
          types: ['x'],
          enabled: false,
          targets: [{ destinationId: a.destinationId }],
        },
        SYSTEM_ACTOR,
      ),
    );
    const enabled = await inWs(a.ws, (t) => listRulesForInstallation(t, a.installationId));
    expect(enabled.map((r) => r.name)).toEqual(['all']);
  });

  it('replaces targets on update and removes them on delete', async () => {
    const rule = await inWs(a.ws, (t) =>
      createRule(
        t,
        {
          installationId: a.installationId,
          name: 'upd',
          types: ['a'],
          targets: [{ destinationId: a.destinationId }],
        },
        SYSTEM_ACTOR,
      ),
    );
    const updated = await inWs(a.ws, (t) =>
      updateRule(t, rule.id, { types: ['a', 'b'], targets: [] }, SYSTEM_ACTOR),
    );
    expect(updated.types).toEqual(['a', 'b']);
    expect(updated.targets).toEqual([]);
    await inWs(a.ws, (t) => deleteRule(t, rule.id, SYSTEM_ACTOR));
    expect((await inWs(a.ws, (t) => listRules(t))).map((r) => r.id)).not.toContain(rule.id);
  });

  it('rejects targets and installations of another workspace', async () => {
    await expect(
      inWs(b.ws, (t) =>
        createRule(
          t,
          {
            installationId: b.installationId,
            name: 'x',
            types: ['*'],
            targets: [{ destinationId: a.destinationId }],
          },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      inWs(b.ws, (t) =>
        createRule(
          t,
          { installationId: a.installationId, name: 'x', types: ['*'], targets: [] },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('rejects an audience of another workspace', async () => {
    const audA = await inWs(a.ws, (t) =>
      createAudience(t, { name: `aud-${randomUUID()}` }, SYSTEM_ACTOR),
    );
    await expect(
      inWs(b.ws, (t) =>
        createRule(
          t,
          {
            installationId: b.installationId,
            name: 'x',
            types: ['*'],
            targets: [{ audienceId: audA.id }],
          },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toMatchObject({ name: 'RepoNotFoundError', entity: 'audience', id: audA.id });
  });

  it('rejects a destination whose connection is soft-deleted', async () => {
    const extra = await extraDestination(a.ws, 'gone');
    await inWs(a.ws, (t) => deleteConnection(t, extra.connectionId, SYSTEM_ACTOR));
    await expect(
      inWs(a.ws, (t) =>
        createRule(
          t,
          {
            installationId: a.installationId,
            name: 'x',
            types: ['*'],
            targets: [{ destinationId: extra.destinationId }],
          },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toMatchObject({
      name: 'RepoNotFoundError',
      entity: 'destination',
      id: extra.destinationId,
    });
  });

  it('rejects a revoked installation', async () => {
    const inst = await inWs(a.ws, async (t) => {
      const app = await createApp(
        t,
        { name: 'rv', slug: `rv-${randomUUID()}`, visibility: 'private' },
        SYSTEM_ACTOR,
      );
      const i = await createInstallation(
        t,
        { appId: app.id, tokenHash: randomUUID(), tokenPrefix: 'ow_inst_test' },
        SYSTEM_ACTOR,
      );
      await revokeInstallation(t, i.id, SYSTEM_ACTOR);
      return i;
    });
    await expect(
      inWs(a.ws, (t) =>
        createRule(
          t,
          { installationId: inst.id, name: 'x', types: ['*'], targets: [] },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toMatchObject({ name: 'RepoNotFoundError', entity: 'installation' });
  });

  it('keeps the previous targets when an update names a foreign destination', async () => {
    const rule = await inWs(a.ws, (t) =>
      createRule(
        t,
        {
          installationId: a.installationId,
          name: 'keep',
          types: ['a'],
          targets: [{ destinationId: a.destinationId }],
        },
        SYSTEM_ACTOR,
      ),
    );
    await expect(
      inWs(a.ws, (t) =>
        updateRule(t, rule.id, { targets: [{ destinationId: b.destinationId }] }, SYSTEM_ACTOR),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    const after = (await inWs(a.ws, (t) => listRules(t))).find((r) => r.id === rule.id);
    expect(after?.targets).toEqual([{ destinationId: a.destinationId }]);
  });

  it('removes duplicate targets', async () => {
    const rule = await inWs(a.ws, (t) =>
      createRule(
        t,
        {
          installationId: a.installationId,
          name: 'dup',
          types: ['a'],
          targets: [{ destinationId: a.destinationId }, { destinationId: a.destinationId }],
        },
        SYSTEM_ACTOR,
      ),
    );
    expect(rule.targets).toEqual([{ destinationId: a.destinationId }]);
  });

  it('audits create, update and delete without rule contents', async () => {
    const rule = await inWs(a.ws, (t) =>
      createRule(
        t,
        { installationId: a.installationId, name: 'aud', types: ['a'], targets: [] },
        SYSTEM_ACTOR,
      ),
    );
    await inWs(a.ws, (t) => updateRule(t, rule.id, { name: 'aud2' }, SYSTEM_ACTOR));
    await inWs(a.ws, (t) => deleteRule(t, rule.id, SYSTEM_ACTOR));
    const entries = (await inWs(a.ws, (t) => listAuditLog(t, { limit: 200 }))).filter(
      (e) => e.targetId === rule.id,
    );
    expect(entries.map((e) => e.action).sort()).toEqual([
      'rule.created',
      'rule.deleted',
      'rule.updated',
    ]);
    expect(entries.find((e) => e.action === 'rule.updated')?.data).toEqual({ fields: ['name'] });
  });

  it('hides rules from another workspace (update, delete, list)', async () => {
    const rule = await inWs(a.ws, (t) =>
      createRule(
        t,
        { installationId: a.installationId, name: 'hidden', types: ['a'], targets: [] },
        SYSTEM_ACTOR,
      ),
    );
    await expect(
      inWs(b.ws, (t) => updateRule(t, rule.id, { name: 'pwned' }, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(inWs(b.ws, (t) => deleteRule(t, rule.id, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
    expect((await inWs(b.ws, (t) => listRules(t))).map((r) => r.id)).not.toContain(rule.id);
    expect(await inWs(b.ws, (t) => listRulesForInstallation(t, a.installationId))).toEqual([]);
    const still = (await inWs(a.ws, (t) => listRules(t))).find((r) => r.id === rule.id);
    expect(still?.name).toBe('hidden');
  });
});

describe('events', () => {
  it('inserts idempotently and enqueues route_event exactly once in the same transaction', async () => {
    const key = randomUUID();
    const first = await inWs(a.ws, (t) =>
      insertEvent(t, {
        installationId: a.installationId,
        idempotencyKey: key,
        type: 'generic',
        severity: 'info',
        message: msg,
      }),
    );
    const second = await inWs(a.ws, (t) =>
      insertEvent(t, {
        installationId: a.installationId,
        idempotencyKey: key,
        type: 'generic',
        severity: 'info',
        message: msg,
      }),
    );
    expect(first.duplicate).toBe(false);
    expect(second).toEqual({ eventId: first.eventId, duplicate: true });
    expect(await jobCount('route_event', 'eventId', first.eventId)).toBe(1);
    const routeJobs = (await listQueuedJobs(env.owner)).filter(
      (j) => j.payload.eventId === first.eventId,
    );
    expect(routeJobs.map((j) => j.queueName)).toEqual([`route:${a.installationId}`]);
  });

  it('does not enqueue when the transaction rolls back', async () => {
    let eventId = '';
    await expect(
      inWs(a.ws, async (t) => {
        eventId = (
          await insertEvent(t, {
            installationId: a.installationId,
            idempotencyKey: randomUUID(),
            type: 'generic',
            severity: 'info',
            message: msg,
          })
        ).eventId;
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await jobCount('route_event', 'eventId', eventId)).toBe(0);
  });

  it('rejects an installation of another workspace and hides foreign events', async () => {
    await expect(
      inWs(b.ws, (t) =>
        insertEvent(t, {
          installationId: a.installationId,
          idempotencyKey: randomUUID(),
          type: 'generic',
          severity: 'info',
          message: msg,
        }),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    const ev = await inWs(a.ws, (t) =>
      insertEvent(t, {
        installationId: a.installationId,
        idempotencyKey: randomUUID(),
        type: 'generic',
        severity: 'info',
        message: msg,
      }),
    );
    expect(await inWs(b.ws, (t) => getEvent(t, ev.eventId))).toBeNull();
    await inWs(a.ws, (t) => markEventRouted(t, ev.eventId));
    expect((await inWs(a.ws, (t) => getEvent(t, ev.eventId)))?.routedAt).toBeInstanceOf(Date);
  });

  it('does not mark a foreign event routed', async () => {
    const ev = await newEvent(a);
    await expect(inWs(b.ws, (t) => markEventRouted(t, ev.eventId))).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
    expect((await inWs(a.ws, (t) => getEvent(t, ev.eventId)))?.routedAt).toBeNull();
  });

  it('rejects an empty idempotency key', async () => {
    await expect(
      inWs(a.ws, (t) =>
        insertEvent(t, {
          installationId: a.installationId,
          idempotencyKey: '',
          type: 'generic',
          severity: 'info',
          message: msg,
        }),
      ),
    ).rejects.toBeInstanceOf(RepoInputError);
  });

  it('dedupes concurrent inserts of the same key to one event and one job', async () => {
    const key = randomUUID();
    const insert = () =>
      inWs(a.ws, (t) =>
        insertEvent(t, {
          installationId: a.installationId,
          idempotencyKey: key,
          type: 'generic',
          severity: 'info',
          message: msg,
        }),
      );
    const results = await Promise.all([insert(), insert(), insert(), insert()]);
    const ids = new Set(results.map((r) => r.eventId));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const [eventId] = [...ids];
    expect(await jobCount('route_event', 'eventId', eventId ?? '')).toBe(1);
  });
});

describe('deliveries', () => {
  it('creates deliveries once, enqueues send_delivery on the connection lane and loads a decrypted context', async () => {
    const ev = await inWs(a.ws, (t) =>
      insertEvent(t, {
        installationId: a.installationId,
        idempotencyKey: randomUUID(),
        type: 'generic',
        severity: 'info',
        message: msg,
      }),
    );
    const target = { destinationId: a.destinationId, connectionId: a.connectionId };
    const created = await inWs(a.ws, (t) => createDeliveries(t, ev.eventId, [target, target]));
    expect(created).toHaveLength(1);
    expect(await inWs(a.ws, (t) => createDeliveries(t, ev.eventId, [target]))).toEqual([]);
    const deliveryId = created[0]?.id ?? '';
    const sendJobs = (await listQueuedJobs(env.owner)).filter(
      (j) => j.payload.deliveryId === deliveryId,
    );
    expect(sendJobs.map((j) => ({ queueName: j.queueName, key: j.key }))).toEqual([
      { queueName: `conn:${a.connectionId}`, key: `send:${deliveryId}` },
    ]);

    const ctx = await inWs(a.ws, (t) => loadDeliveryContext(t, deliveryId));
    expect(ctx?.config).toEqual({ botToken: 'alpha-token' });
    expect(ctx?.event.message).toEqual(msg);
    expect(ctx?.destination.id).toBe(a.destinationId);

    await inWs(a.ws, (t) =>
      updateDelivery(t, deliveryId, {
        status: 'delivered',
        platformMessageId: '42',
        deliveredAt: env.clock.now(),
      }),
    );
    expect((await inWs(a.ws, (t) => getDelivery(t, deliveryId)))?.status).toBe('delivered');
    expect((await inWs(a.ws, (t) => listDeliveries(t, { limit: 5 }))).map((d) => d.id)).toContain(
      deliveryId,
    );
  });

  it('isolates deliveries between workspaces', async () => {
    const ev = await inWs(a.ws, (t) =>
      insertEvent(t, {
        installationId: a.installationId,
        idempotencyKey: randomUUID(),
        type: 'generic',
        severity: 'info',
        message: msg,
      }),
    );
    const [d] = await inWs(a.ws, (t) =>
      createDeliveries(t, ev.eventId, [
        { destinationId: a.destinationId, connectionId: a.connectionId },
      ]),
    );
    const id = d?.id ?? '';
    await expect(
      inWs(b.ws, (t) =>
        createDeliveries(t, ev.eventId, [
          { destinationId: b.destinationId, connectionId: b.connectionId },
        ]),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    expect(await inWs(b.ws, (t) => getDelivery(t, id))).toBeNull();
    expect(await inWs(b.ws, (t) => loadDeliveryContext(t, id))).toBeNull();
    await expect(
      inWs(b.ws, (t) => updateDelivery(t, id, { status: 'failed' })),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    expect((await inWs(a.ws, (t) => getDelivery(t, id)))?.status).toBe('pending');
    expect(
      (await inWs(b.ws, (t) => listDeliveries(t, { limit: 200 }))).map((x) => x.id),
    ).not.toContain(id);
  });

  it('rejects a foreign destination for an own event', async () => {
    const ev = await newEvent(b);
    await expect(
      inWs(b.ws, (t) =>
        createDeliveries(t, ev.eventId, [
          { destinationId: a.destinationId, connectionId: a.connectionId },
        ]),
      ),
    ).rejects.toMatchObject({ name: 'RepoNotFoundError', entity: 'destination' });
  });

  it('rejects a target whose connection is not the destination connection', async () => {
    const other = await extraDestination(a.ws, 'lane');
    const ev = await newEvent(a);
    await expect(
      inWs(a.ws, (t) =>
        createDeliveries(t, ev.eventId, [
          { destinationId: a.destinationId, connectionId: other.connectionId },
        ]),
      ),
    ).rejects.toBeInstanceOf(RepoInputError);
    expect(
      (await listQueuedJobs(env.owner)).filter((j) => j.queueName === `conn:${other.connectionId}`),
    ).toEqual([]);
  });

  it('rejects a soft-deleted destination and returns no context once the connection is deleted', async () => {
    const extra = await extraDestination(a.ws, 'ctx');
    const ev = await newEvent(a);
    const [d] = await inWs(a.ws, (t) => createDeliveries(t, ev.eventId, [extra]));
    const id = d?.id ?? '';
    await inWs(a.ws, (t) => deleteConnection(t, extra.connectionId, SYSTEM_ACTOR));
    expect(await inWs(a.ws, (t) => loadDeliveryContext(t, id))).toBeNull();
    expect((await inWs(a.ws, (t) => getDelivery(t, id)))?.status).toBe('failed');
    const ev2 = await newEvent(a);
    await expect(
      inWs(a.ws, (t) => createDeliveries(t, ev2.eventId, [extra])),
    ).rejects.toMatchObject({ name: 'RepoNotFoundError', entity: 'destination' });
  });

  it('passes runAt to the send_delivery job', async () => {
    const ev = await newEvent(a);
    const runAt = new Date('2030-01-01T00:00:00.000Z');
    const [d] = await inWs(a.ws, (t) =>
      createDeliveries(t, ev.eventId, [
        { destinationId: a.destinationId, connectionId: a.connectionId, runAt },
      ]),
    );
    const job = (await listQueuedJobs(env.owner)).find((j) => j.payload.deliveryId === d?.id);
    expect(job?.runAt.toISOString()).toBe(runAt.toISOString());
  });

  it('pages through rows created within one millisecond without skipping any', async () => {
    const c = await buildGraph('charlie');
    const evIds: string[] = [];
    for (let i = 0; i < 4; i++) evIds.push((await newEvent(c)).eventId);
    const ids = evIds.map(() => newId());
    // Owner role, one statement (one now()): four sub-millisecond timestamps inside the same millisecond,
    // as a raw writer or the P0 column default would store them.
    await env.owner.query(
      `insert into deliveries (id, workspace_id, event_id, destination_id, connection_id, created_at, updated_at)
       select x.id, $1, x.event_id, $2, $3, date_trunc('milliseconds', now()) + x.n * interval '100 microseconds', now()
       from unnest($4::uuid[], $5::uuid[]) with ordinality as x(id, event_id, n)`,
      [c.ws, c.destinationId, c.connectionId, ids, evIds],
    );
    const stored = await env.owner.query<{ us: string }>(
      `select distinct date_trunc('milliseconds', created_at)::text as us from deliveries where workspace_id = $1`,
      [c.ws],
    );
    expect(stored.rows).toHaveLength(1);
    const seen: string[] = [];
    let before: { createdAt: Date; id: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const rows = await inWs(c.ws, (t) => listDeliveries(t, { limit: 1, before }));
      const row = rows[0];
      if (!row) break;
      seen.push(row.id);
      before = { createdAt: row.createdAt, id: row.id };
    }
    expect(seen.sort()).toEqual([...ids].sort());
  });
});

describe('job outbox', () => {
  it('enqueues through the app role with a replacing job key in tenant and system scope', async () => {
    const connectionId = randomUUID();
    await inWs(a.ws, (t) =>
      enqueueJob(
        t,
        'health_check_connection',
        { connectionId },
        { jobKey: healthJobKey(connectionId) },
      ),
    );
    await withSystem(env.db, SYSTEM, (s) =>
      enqueueJob(
        s,
        'health_check_connection',
        { connectionId },
        { jobKey: healthJobKey(connectionId), jobKeyMode: 'replace', maxAttempts: 3 },
      ),
    );
    const jobs = (await listQueuedJobs(env.owner)).filter(
      (j) => j.key === healthJobKey(connectionId),
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ connectionId });
  });
});
