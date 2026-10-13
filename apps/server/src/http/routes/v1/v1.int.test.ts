import { events, installations } from '@owlwire/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type SeedResult, seedDevWorkspace } from '../../../system/dev-seed.js';
import { createHarness, type Harness } from '../../../test/harness.js';
import { listJobs } from '../../../test/jobs.js';

let h: Harness;
let seed: SeedResult;

beforeAll(async () => {
  h = await createHarness();
  seed = await seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
    platform: 'webhook',
    chatId: 'v1',
  });
});
afterAll(async () => {
  await h.close();
});

function postEvent(body: unknown, headers: Record<string, string> = {}) {
  return h.app.request('/v1/events', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${seed.token}`,
      'content-type': 'application/json',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function routeJobsFor(eventId: string) {
  return (await listJobs(h.deps.pool)).filter(
    (j) => j.task === 'route_event' && j.payload.eventId === eventId,
  );
}

describe('POST /v1/events', () => {
  it('accepts an event, stores the message and enqueues route_event in the same transaction', async () => {
    const res = await postEvent({
      type: 'player.inactive',
      body: '**Ali** is idle',
      data: { a: 1 },
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { eventId: string; duplicate: boolean };
    expect(body.duplicate).toBe(false);
    const [row] = await h.deps.db.select().from(events).where(eq(events.id, body.eventId));
    expect(row).toMatchObject({
      type: 'player.inactive',
      severity: 'info',
      workspaceId: seed.workspaceId,
      installationId: seed.installationId,
    });
    expect(row?.message).toEqual({
      type: 'player.inactive',
      severity: 'info',
      body: '**Ali** is idle',
      data: { a: 1 },
    });
    expect(await routeJobsFor(body.eventId)).toHaveLength(1);
  });

  it('returns the same event for a repeated idempotency key without a second job', async () => {
    const first = (await (
      await postEvent({ type: 'a', body: 'x', idempotencyKey: 'k-1' })
    ).json()) as {
      eventId: string;
    };
    const again = await postEvent({ type: 'a', body: 'x', idempotencyKey: 'k-1' });
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ eventId: first.eventId, duplicate: true });
    expect(await routeJobsFor(first.eventId)).toHaveLength(1);
  });

  it('stores distinct events that carry no idempotency key at all', async () => {
    const a = (await (await postEvent({ type: 'a', body: 'first' })).json()) as {
      eventId: string;
      duplicate: boolean;
    };
    const b = (await (await postEvent({ type: 'a', body: 'second' })).json()) as {
      eventId: string;
      duplicate: boolean;
    };
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(b.eventId).not.toBe(a.eventId);
  });

  it('rejects an empty body idempotency key instead of collapsing later events into it', async () => {
    const empty = await postEvent({ type: 'a', body: 'x', idempotencyKey: '' });
    expect(empty.status).toBe(422);
    expect(((await empty.json()) as { code: string }).code).toBe('validation_failed');
    const blankHeader = (await (
      await postEvent({ type: 'a', body: 'x' }, { 'idempotency-key': '   ' })
    ).json()) as { duplicate: boolean };
    const again = (await (
      await postEvent({ type: 'a', body: 'y' }, { 'idempotency-key': '   ' })
    ).json()) as { duplicate: boolean };
    expect(blankHeader.duplicate).toBe(false);
    expect(again.duplicate).toBe(false);
  });

  it('uses the Idempotency-Key header when the body has no key', async () => {
    const a = (await (
      await postEvent({ type: 'a', body: 'x' }, { 'idempotency-key': 'hdr-1' })
    ).json()) as {
      eventId: string;
    };
    const b = (await (
      await postEvent({ type: 'a', body: 'y' }, { 'idempotency-key': 'hdr-1' })
    ).json()) as {
      eventId: string;
      duplicate: boolean;
    };
    expect(b).toEqual({ eventId: a.eventId, duplicate: true });
    const long = await postEvent({ type: 'a', body: 'x' }, { 'idempotency-key': 'k'.repeat(129) });
    expect(long.status).toBe(422);
  });

  it('rejects missing, malformed and unknown tokens with 401 problem details', async () => {
    const none = await h.app.request('/v1/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(none.status).toBe(401);
    expect(none.headers.get('content-type')).toContain('application/problem+json');
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    expect(((await none.json()) as { code: string }).code).toBe('unauthorized');

    expect(
      (await postEvent({ type: 'a', body: 'x' }, { authorization: 'Bearer nope' })).status,
    ).toBe(401);
    expect((await postEvent({ type: 'a', body: 'x' }, { authorization: 'Basic abc' })).status).toBe(
      401,
    );
    const unknown = `ow_inst_${'0'.repeat(43)}`;
    expect(
      (await postEvent({ type: 'a', body: 'x' }, { authorization: `Bearer ${unknown}` })).status,
    ).toBe(401);
  });

  it('does not accept the token as a query parameter on /v1/events', async () => {
    const res = await h.app.request(`/v1/events?token=${seed.token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'a', body: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('validates the body', async () => {
    const bad = await postEvent({ type: 'Upper Case', body: '' });
    expect(bad.status).toBe(422);
    const problem = (await bad.json()) as { code: string; detail: string };
    expect(problem.code).toBe('validation_failed');
    expect(problem.detail).toMatch(/type/);
    const malformed = await postEvent('{not json');
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toContain('application/problem+json');
    expect(((await malformed.json()) as { code: string }).code).toBe('validation_failed');
    expect(
      (await postEvent({ type: 'a', body: 'x' }, { 'content-type': 'text/plain' })).status,
    ).toBe(422);
    expect((await postEvent({ events: [{ type: 'a', body: 'x' }] })).status).toBe(422);
  });

  it('rejects types that are not granted to the installation', async () => {
    await h.deps.db
      .update(installations)
      .set({ grantedTypes: ['player.inactive'] })
      .where(eq(installations.id, seed.installationId));
    const denied = await postEvent({ type: 'attack.incoming', body: 'x' });
    expect(denied.status).toBe(422);
    expect(((await denied.json()) as { code: string }).code).toBe('unknown_type');
    expect((await postEvent({ type: 'player.inactive', body: 'x' })).status).toBe(202);
    await h.deps.db
      .update(installations)
      .set({ grantedTypes: null })
      .where(eq(installations.id, seed.installationId));
  });
});

describe('POST /v1/hooks', () => {
  it('accepts a plain text body with the token in the query string', async () => {
    const res = await h.app.request(`/v1/hooks?token=${seed.token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '  Gate opened: 34 ABC 123  ',
    });
    expect(res.status).toBe(202);
    const { eventId } = (await res.json()) as { eventId: string };
    const [row] = await h.deps.db.select().from(events).where(eq(events.id, eventId));
    expect(row?.message).toEqual({
      type: 'generic',
      severity: 'info',
      body: 'Gate opened: 34 ABC 123',
    });
  });

  it('accepts a JSON body with a title and a bearer token', async () => {
    const res = await h.app.request('/v1/hooks', {
      method: 'POST',
      headers: { authorization: `Bearer ${seed.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Gate', body: 'opened' }),
    });
    expect(res.status).toBe(202);
    const { eventId } = (await res.json()) as { eventId: string };
    const [row] = await h.deps.db.select().from(events).where(eq(events.id, eventId));
    expect(row?.message).toMatchObject({ type: 'generic', title: 'Gate', body: 'opened' });
  });

  it('rejects empty bodies and oversized payloads', async () => {
    const empty = await h.app.request(`/v1/hooks?token=${seed.token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '   \n ',
    });
    expect(empty.status).toBe(422);
    const huge = await h.app.request(`/v1/hooks?token=${seed.token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x'.repeat(70_000),
    });
    expect(huge.status).toBe(413);
    expect(((await huge.json()) as { code: string }).code).toBe('payload_too_large');
  });

  it('reports a revoked installation as installation_revoked', async () => {
    const other = await seedDevWorkspace(h.deps.db, h.deps.crypto, h.deps.clock, {
      platform: 'webhook',
      chatId: 'revoked',
    });
    await h.deps.db
      .update(installations)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(installations.id, other.installationId));
    const res = await h.app.request(`/v1/hooks?token=${other.token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(((await res.json()) as { code: string }).code).toBe('installation_revoked');
  });
});
