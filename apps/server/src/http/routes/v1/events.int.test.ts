import { type CatalogTypeUpsert, routeQueue, tenantJobName } from '@owlwire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppFixture, createAppFixture } from '../../../test/app-fixtures.js';
import { listJobs } from '../../../test/jobs.js';

let fx: AppFixture;
let ws: string;

const catalog: CatalogTypeUpsert[] = [
  {
    key: 'account.inactive',
    name: 'Inactive account',
    description: null,
    defaultSeverity: 'high',
    payloadSchema: null,
  },
  {
    key: 'attack.incoming',
    name: 'Incoming attack',
    description: null,
    defaultSeverity: 'critical',
    payloadSchema: {
      type: 'object',
      required: ['target'],
      properties: { target: { type: 'string' } },
    },
  },
  {
    key: 'city.lost',
    name: 'City lost',
    description: null,
    defaultSeverity: 'medium',
    payloadSchema: null,
  },
];
const granted = ['account.inactive', 'attack.incoming', 'generic'];

beforeAll(async () => {
  fx = await createAppFixture();
  ws = await fx.workspace('alpha');
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

const app = () => fx.privateApp(ws, { catalog, grantedTypes: granted });
const post = (token: string, body: unknown, headers: Record<string, string> = {}) =>
  fx.request('/v1/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const problemCode = async (res: Response) => ((await res.json()) as { code: string }).code;
const routeJobs = async (eventId: string) =>
  (await listJobs(fx.owner)).filter(
    (j) => j.task === 'route_event' && j.payload.eventId === eventId,
  );

describe('POST /v1/events (single)', () => {
  it('accepts an event, applies the catalog severity and enqueues routing on the installation queue', async () => {
    const { token, installationId } = await app();
    const res = await post(token, { type: 'account.inactive', body: 'Player **X** went inactive' });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { eventId: string; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    const { rows } = await fx.owner.query<{ severity: string }>(
      `select severity from events where id = $1`,
      [body.eventId],
    );
    expect(rows[0]?.severity).toBe('high');
    expect((await routeJobs(body.eventId)).map((j) => j.queue_name)).toEqual([
      tenantJobName(ws, routeQueue(installationId)),
    ]);
  });

  it('returns the same event for a repeated Idempotency-Key header', async () => {
    const { token } = await app();
    const ev = { type: 'account.inactive', body: 'x' };
    const a = (await (await post(token, ev, { 'idempotency-key': 'k1' })).json()) as {
      eventId: string;
    };
    const res = await post(token, ev, { 'idempotency-key': 'k1' });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ eventId: a.eventId, duplicate: true });
  });

  it('rejects differing header and body idempotency keys with 400', async () => {
    const { token } = await app();
    const res = await post(
      token,
      { type: 'account.inactive', body: 'x', idempotencyKey: 'a' },
      { 'idempotency-key': 'b' },
    );
    expect(res.status).toBe(400);
    expect(await problemCode(res)).toBe('validation_failed');
  });

  it('maps catalog, grant and schema failures to problem codes', async () => {
    const { token } = await app();
    const unknown = await post(token, { type: 'nope.nope', body: 'x' });
    expect([unknown.status, await problemCode(unknown)]).toEqual([422, 'unknown_type']);
    const forbidden = await post(token, { type: 'city.lost', body: 'x' });
    expect([forbidden.status, await problemCode(forbidden)]).toEqual([403, 'forbidden']);
    const invalid = await post(token, { type: 'attack.incoming', body: 'x', data: { target: 5 } });
    expect([invalid.status, await problemCode(invalid)]).toEqual([422, 'validation_failed']);
  });

  it('rejects schema violations with 422 and malformed JSON with 400', async () => {
    const { token } = await app();
    const missing = await post(token, { type: 'account.inactive' });
    expect([missing.status, await problemCode(missing)]).toEqual([422, 'validation_failed']);
    const broken = await post(token, '{"type":');
    expect([broken.status, await problemCode(broken)]).toEqual([400, 'validation_failed']);
  });

  it('rejects bodies over 64 KiB', async () => {
    const { token } = await app();
    const res = await post(token, {
      type: 'account.inactive',
      body: 'x',
      data: { blob: 'a'.repeat(70_000) },
    });
    expect(res.status).toBe(413);
    expect(await problemCode(res)).toBe('payload_too_large');
  });

  it('handles concurrent duplicate requests', async () => {
    const { token } = await app();
    const ev = { type: 'account.inactive', body: 'x', idempotencyKey: 'race' };
    const [a, b] = await Promise.all([post(token, ev), post(token, ev)]);
    expect([a.status, b.status]).toEqual([202, 202]);
    const ra = (await a.json()) as { eventId: string; duplicate: boolean };
    const rb = (await b.json()) as { eventId: string; duplicate: boolean };
    expect(ra.eventId).toBe(rb.eventId);
    expect([ra.duplicate, rb.duplicate].sort()).toEqual([false, true]);
    expect(await routeJobs(ra.eventId)).toHaveLength(1);
  });

  it('requires a valid, active installation token', async () => {
    const { token, installationId } = await app();
    expect((await post('ow_inst_nope', { type: 'account.inactive', body: 'x' })).status).toBe(401);
    await fx.owner.query(
      `update installations set status = 'revoked', revoked_at = now() where id = $1`,
      [installationId],
    );
    const res = await post(token, { type: 'account.inactive', body: 'x' });
    expect([res.status, await problemCode(res)]).toEqual([401, 'installation_revoked']);
  });
});

describe('POST /v1/events (batch)', () => {
  it('accepts valid items and reports per-item errors in order', async () => {
    const { token } = await app();
    const res = await post(token, {
      events: [
        { type: 'account.inactive', body: 'a', idempotencyKey: 'b1' },
        { type: 'nope.nope', body: 'b' },
        { type: 'city.lost', body: 'c' },
        { type: 'account.inactive', body: 'a again', idempotencyKey: 'b1' },
      ],
    });
    expect(res.status).toBe(202);
    const { results } = (await res.json()) as { results: Array<Record<string, unknown>> };
    expect(results).toHaveLength(4);
    expect(results[0]).toMatchObject({ duplicate: false });
    expect(results[1]).toMatchObject({ error: { code: 'unknown_type' } });
    expect(results[2]).toMatchObject({ error: { code: 'forbidden' } });
    expect(results[3]).toEqual({ eventId: results[0]?.eventId, duplicate: true });
  });

  it('stores events without a key as distinct events', async () => {
    const { token } = await app();
    const res = await post(token, {
      events: [
        { type: 'account.inactive', body: 'a' },
        { type: 'account.inactive', body: 'b' },
      ],
    });
    expect(res.status).toBe(202);
    const { results } = (await res.json()) as {
      results: Array<{ eventId: string; duplicate: boolean }>;
    };
    expect(results.map((r) => r.duplicate)).toEqual([false, false]);
    expect(results[0]?.eventId).not.toBe(results[1]?.eventId);
  });

  it('rejects the Idempotency-Key header on batches with 400', async () => {
    const { token } = await app();
    const res = await post(
      token,
      { events: [{ type: 'account.inactive', body: 'a' }] },
      { 'idempotency-key': 'x' },
    );
    expect([res.status, await problemCode(res)]).toEqual([400, 'validation_failed']);
  });

  it('rejects more than 100 events with 422', async () => {
    const { token } = await app();
    const events = Array.from({ length: 101 }, (_, i) => ({
      type: 'account.inactive',
      body: `e${i}`,
    }));
    expect((await post(token, { events })).status).toBe(422);
  });

  it('charges the rate limit per event', async () => {
    const ingest = fx.deps.config.edition.ingest;
    ingest.ratePerMinutePerToken = 3;
    try {
      const { token } = await app();
      const two = {
        events: [
          { type: 'account.inactive', body: 'a' },
          { type: 'account.inactive', body: 'b' },
        ],
      };
      expect((await post(token, two)).status).toBe(202);
      const res = await post(token, two);
      expect(res.status).toBe(429);
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    } finally {
      ingest.ratePerMinutePerToken = 600;
    }
  });

  it('refuses a batch larger than the rate limit with 422 and charges single requests once', async () => {
    const ingest = fx.deps.config.edition.ingest;
    ingest.ratePerMinutePerToken = 3;
    try {
      const { token } = await app();
      const four = {
        events: Array.from({ length: 4 }, (_, i) => ({ type: 'account.inactive', body: `${i}` })),
      };
      const big = await post(token, four);
      expect([big.status, await problemCode(big)]).toEqual([422, 'validation_failed']);
      // The refused batch gave its token back, and each single event costs exactly one token.
      for (let i = 0; i < 3; i++) {
        expect((await post(token, { type: 'account.inactive', body: `s${i}` })).status).toBe(202);
      }
      expect((await post(token, { type: 'account.inactive', body: 'over' })).status).toBe(429);
    } finally {
      ingest.ratePerMinutePerToken = 600;
    }
  });
});

describe('GET /v1/events/{id}', () => {
  it('returns the status of an own event', async () => {
    const { token } = await app();
    const { eventId } = (await (
      await post(token, { type: 'account.inactive', body: 'x' })
    ).json()) as { eventId: string };
    const res = await fx.request(`/v1/events/${eventId}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: eventId,
      status: 'received',
      deliveries: { total: 0, delivered: 0, failed: 0, pending: 0 },
    });
  });

  it('hides events of other installations and rejects malformed ids', async () => {
    const a = await app();
    const b = await app();
    const { eventId } = (await (
      await post(a.token, { type: 'account.inactive', body: 'x' })
    ).json()) as {
      eventId: string;
    };
    const other = await fx.request(`/v1/events/${eventId}`, {
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(other.status).toBe(404);
    const bad = await fx.request('/v1/events/not-a-uuid', {
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(bad.status).toBe(422);
  });
});
