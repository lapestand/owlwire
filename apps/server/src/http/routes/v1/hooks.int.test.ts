import { revokeInstallation, SYSTEM_ACTOR, tenantScope, withTenant } from '@owlwire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestKeys } from '../../../system/rate-limit.js';
import { type AppFixture, createAppFixture } from '../../../test/app-fixtures.js';

let fx: AppFixture;
let ws: string;

beforeAll(async () => {
  fx = await createAppFixture();
  ws = await fx.workspace('alpha');
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

async function storedMessage(eventId: string) {
  const { rows } = await fx.owner.query<{
    type: string;
    message: { title?: string; body: string };
  }>(`select type, message from events where id = $1`, [eventId]);
  return rows[0];
}

describe('POST /v1/hooks', () => {
  it('accepts text/plain bodies as generic events', async () => {
    const { token } = await fx.privateApp(ws);
    const res = await fx.request('/v1/hooks', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: '  Plate 34 ABC 123 at gate 1\n',
    });
    expect(res.status).toBe(202);
    const { eventId } = (await res.json()) as { eventId: string };
    expect(await storedMessage(eventId)).toMatchObject({
      type: 'generic',
      message: { body: 'Plate 34 ABC 123 at gate 1' },
    });
  });

  it('accepts curl -d form bodies as plain text', async () => {
    const { token } = await fx.privateApp(ws);
    const res = await fx.request(`/v1/hooks?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'Gate opened',
    });
    expect(res.status).toBe(202);
    const { eventId } = (await res.json()) as { eventId: string };
    expect((await storedMessage(eventId))?.message.body).toBe('Gate opened');
  });

  it('accepts JSON with a title', async () => {
    const { token } = await fx.privateApp(ws);
    const res = await fx.request('/v1/hooks', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Alarm', body: 'Motion detected' }),
    });
    expect(res.status).toBe(202);
    const { eventId } = (await res.json()) as { eventId: string };
    expect((await storedMessage(eventId))?.message).toMatchObject({
      title: 'Alarm',
      body: 'Motion detected',
    });
  });

  it('rejects empty and oversized bodies with 422 and invalid JSON with 400', async () => {
    const { token } = await fx.privateApp(ws);
    const send = (body: string, type = 'text/plain') =>
      fx.request('/v1/hooks', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': type },
        body,
      });
    expect((await send('   ')).status).toBe(422);
    expect((await send('x'.repeat(8001))).status).toBe(422);
    expect((await send('{"body":', 'application/json')).status).toBe(400);
  });

  it('deduplicates with the Idempotency-Key header', async () => {
    const { token } = await fx.privateApp(ws);
    const send = () =>
      fx.request('/v1/hooks', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'text/plain',
          'idempotency-key': 'plate-1',
        },
        body: 'same',
      });
    const a = (await (await send()).json()) as { eventId: string };
    expect(await (await send()).json()).toEqual({ eventId: a.eventId, duplicate: true });
  });

  it('forbids hooks when generic is not granted', async () => {
    const { token } = await fx.privateApp(ws, {
      catalog: [
        {
          key: 'alarm',
          name: 'Alarm',
          description: null,
          defaultSeverity: 'high',
          payloadSchema: null,
        },
      ],
      grantedTypes: ['alarm'],
    });
    const res = await fx.request('/v1/hooks', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(403);
  });

  it('takes exactly one rate limit token per request', async () => {
    const { token, installationId } = await fx.privateApp(ws);
    const res = await fx.request(`/v1/hooks?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'once',
    });
    expect(res.status).toBe(202);
    const { rows } = await fx.owner.query<{ tokens: number }>(
      'select tokens from rate_buckets where scope = $1',
      [ingestKeys.installation(installationId)],
    );
    // The fixture clock stands still, so the bucket does not refill between the two reads.
    expect(rows).toEqual([{ tokens: fx.deps.config.edition.ingest.ratePerMinutePerToken - 1 }]);
  });

  it('reports a revoked installation as installation_revoked', async () => {
    const { token, installationId } = await fx.privateApp(ws);
    await withTenant(fx.deps.db, tenantScope(ws), (t) =>
      revokeInstallation(t, installationId, SYSTEM_ACTOR),
    );
    const res = await fx.request(`/v1/hooks?token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'x',
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(((await res.json()) as { code: string }).code).toBe('installation_revoked');
  });
});
