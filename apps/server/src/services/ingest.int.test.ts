import { listCatalog, openDatabase, tenantScope, withTenant } from '@owlwire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemError } from '../errors.js';
import { type AppFixture, createAppFixture } from '../test/app-fixtures.js';
import { listJobs } from '../test/jobs.js';
import { type IngestPrincipal, ingestEvents } from './ingest.js';
import type { PayloadSchemaRegistry } from './payload-schema.js';
import { type ServiceDeps, serviceDeps } from './types.js';

let fx: AppFixture;
let d: ServiceDeps;
let ws: string;

const catalog = [
  {
    key: 'generic',
    name: 'Generic',
    description: null,
    defaultSeverity: 'info',
    payloadSchema: null,
  },
  {
    key: 'attack.incoming',
    name: 'Attack',
    description: null,
    defaultSeverity: 'high',
    payloadSchema: { type: 'object', required: ['target'] },
  },
] as const;

async function principal(grantedTypes: string[] | null = null): Promise<IngestPrincipal> {
  const app = await fx.privateApp(ws, {
    catalog: catalog.map((c) => ({ ...c, payloadSchema: c.payloadSchema ?? null })),
    grantedTypes,
  });
  return { installationId: app.installationId, workspaceId: ws, appId: app.appId, grantedTypes };
}

async function storedKeys(installationId: string): Promise<string[]> {
  const { rows } = await fx.owner.query<{ idempotency_key: string }>(
    `select idempotency_key from events where installation_id = $1 order by idempotency_key`,
    [installationId],
  );
  return rows.map((r) => r.idempotency_key);
}

async function routeJobCount(installationId: string): Promise<number> {
  const queue = `w:${ws}:route:${installationId}`;
  return (await listJobs(fx.owner)).filter(
    (j) => j.task === 'route_event' && j.queue_name === queue,
  ).length;
}

beforeAll(async () => {
  fx = await createAppFixture();
  d = serviceDeps(fx.deps);
  ws = await fx.workspace('ingest');
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

describe('ingestEvents', () => {
  it('answers in input order, stores only valid events and enqueues one route job per new event', async () => {
    const p = await principal(['generic', 'attack.incoming']);
    const results = await ingestEvents(
      d,
      p,
      [
        { type: 'generic', body: 'z', idempotencyKey: 'z' },
        { type: 'city.lost', body: 'x', idempotencyKey: 'u' },
        { type: 'generic', body: 'a', idempotencyKey: 'a' },
        { type: 'attack.incoming', body: 'no target', idempotencyKey: 'v' },
        { type: 'generic', body: 'z again', idempotencyKey: 'z' },
      ],
      undefined,
    );
    expect(results).toMatchObject([
      { duplicate: false },
      { error: { code: 'unknown_type' } },
      { duplicate: false },
      { error: { code: 'validation_failed' } },
      { duplicate: true },
    ]);
    const [first, , second, , repeat] = results as { eventId: string }[];
    expect(repeat?.eventId).toBe(first?.eventId);
    expect(second?.eventId).not.toBe(first?.eventId);
    expect(await storedKeys(p.installationId)).toEqual(['a', 'z']);

    const { rows } = await fx.owner.query<{ id: string; message: Record<string, unknown> }>(
      `select id, message from events where installation_id = $1 and idempotency_key = 'z'`,
      [p.installationId],
    );
    // The earlier of two events with one key is the one stored.
    expect(rows[0]?.message).toMatchObject({ body: 'z', severity: 'info' });
    const jobs = (await listJobs(fx.owner)).filter(
      (j) =>
        j.task === 'route_event' &&
        results.some((r) => 'eventId' in r && r.eventId === j.payload.eventId),
    );
    expect(jobs).toHaveLength(2);
    expect(new Set(jobs.map((j) => j.queue_name))).toEqual(
      new Set([`w:${ws}:route:${p.installationId}`]),
    );
  });

  it('does not deadlock when concurrent batches share keys in opposite orders', async () => {
    // Retries are off, so a deadlock would fail the test: the key order alone must prevent it.
    const p = await principal();
    const keys = Array.from({ length: 20 }, (_, i) => `k-${String(i).padStart(2, '0')}`);
    const batch = (order: string[]) =>
      ingestEvents(
        d,
        p,
        order.map((k) => ({ type: 'generic', body: k, idempotencyKey: k })),
        undefined,
        { deadlockAttempts: 1 },
      );
    const [up, down] = await Promise.all([batch(keys), batch([...keys].reverse())]);
    const ids = (r: typeof up) => r.map((x) => ('eventId' in x ? x.eventId : 'error'));
    expect(ids(up)).toEqual([...ids(down)].reverse());
    const duplicates = [...up, ...down].filter((x) => 'duplicate' in x && x.duplicate);
    expect(duplicates).toHaveLength(keys.length);
    expect(await storedKeys(p.installationId)).toEqual(keys);
    expect(await routeJobCount(p.installationId)).toBe(keys.length);
  });

  it('retries a transaction aborted as a deadlock on the route queue of a new installation', async () => {
    // The first job of an installation creates its route queue row, locked until commit. A batch that
    // creates it and then reaches a key the other batch already holds deadlocks with that batch (most
    // runs, timing permitting); the aborted one must be retried, not fail the request.
    for (let i = 0; i < 10; i++) {
      const p = await principal();
      const send = (keys: string[]) =>
        ingestEvents(
          d,
          p,
          keys.map((k) => ({ type: 'generic', body: k, idempotencyKey: k })),
          undefined,
        );
      const long = ['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'k'];
      const settled = await Promise.allSettled([send(long), send(['k'])]);
      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(await storedKeys(p.installationId)).toEqual(long);
      // A rolled back attempt leaves no job behind: one route job per stored event.
      expect(await routeJobCount(p.installationId)).toBe(long.length);
    }
  });

  it('answers a deadlock that outlasts the retries with a retryable 503', async () => {
    const rejected: unknown[] = [];
    for (let i = 0; i < 10 && rejected.length === 0; i++) {
      const p = await principal();
      const send = (keys: string[]) =>
        ingestEvents(
          d,
          p,
          keys.map((k) => ({ type: 'generic', body: k, idempotencyKey: k })),
          undefined,
          { deadlockAttempts: 1 },
        );
      const settled = await Promise.allSettled([
        send(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'k']),
        send(['k']),
      ]);
      for (const s of settled) if (s.status === 'rejected') rejected.push(s.reason);
    }
    expect(rejected.length).toBeGreaterThan(0);
    for (const err of rejected) {
      expect(err).toBeInstanceOf(ProblemError);
      expect(err).toMatchObject({
        status: 503,
        code: 'unavailable',
        headers: { 'retry-after': '1' },
      });
    }
  });

  it('holds no database connection while payloads are validated', async () => {
    const p = await principal();
    // One connection only: if ingest held it during validation, the query below could not run and would
    // fail after the pool's connection timeout.
    const small = openDatabase({
      url: fx.deps.config.databaseUrl,
      keyring: fx.deps.keyring,
      clock: fx.clock,
      maxConnections: 1,
    });
    let queriedDuringValidation = false;
    const slow = {
      validate: async () => {
        await withTenant(small, tenantScope(ws), (t) => listCatalog(t, p.appId));
        queriedDuringValidation = true;
        return { ok: true };
      },
    } as unknown as PayloadSchemaRegistry;
    try {
      const results = await ingestEvents(
        { ...d, db: small, payloadSchemas: slow },
        p,
        [
          { type: 'attack.incoming', body: 'x', data: { target: 'a' }, idempotencyKey: 's-1' },
          { type: 'attack.incoming', body: 'y', data: { target: 'b' }, idempotencyKey: 's-2' },
        ],
        undefined,
      );
      expect(results).toMatchObject([{ duplicate: false }, { duplicate: false }]);
      expect(queriedDuringValidation).toBe(true);
    } finally {
      await small.close();
    }
  });

  it('answers a revoked installation with 401 installation_revoked and stores nothing', async () => {
    const p = await principal();
    await fx.owner.query(
      `update installations set status = 'revoked', revoked_at = now() where id = $1`,
      [p.installationId],
    );
    const err = await ingestEvents(
      d,
      p,
      [{ type: 'generic', body: 'x', idempotencyKey: 'r-1' }],
      undefined,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProblemError);
    expect(err).toMatchObject({
      status: 401,
      code: 'installation_revoked',
      headers: { 'www-authenticate': 'Bearer' },
    });
    expect(await storedKeys(p.installationId)).toEqual([]);
  });

  it('uses the header key for an event without its own key', async () => {
    const p = await principal();
    const [r] = await ingestEvents(d, p, [{ type: 'generic', body: 'x' }], ' hdr-1 ');
    expect(r).toMatchObject({ duplicate: false });
    expect(await storedKeys(p.installationId)).toEqual(['hdr-1']);
  });
});
