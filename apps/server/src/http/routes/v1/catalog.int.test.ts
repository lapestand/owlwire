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

const put = (token: string, body: unknown, contentType = 'application/json') =>
  fx.request('/v1/catalog', {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': contentType },
    body: JSON.stringify(body),
  });

const attack = {
  key: 'attack.incoming',
  name: 'Incoming attack',
  defaultSeverity: 'critical',
  payloadSchema: {
    type: 'object',
    required: ['target'],
    properties: { target: { type: 'string' } },
  },
};

describe('PUT /v1/catalog', () => {
  it('lets a public app upsert its catalog with its app key', async () => {
    const { appKey, appId } = await fx.publicApp(ws);
    const res = await put(appKey, { types: [attack] });
    expect(res.status).toBe(200);
    const { types } = (await res.json()) as {
      types: Array<{ key: string; defaultSeverity: string }>;
    };
    expect(types.map((t) => [t.key, t.defaultSeverity])).toEqual([
      ['attack.incoming', 'critical'],
      ['generic', 'info'],
    ]);
    const { rows } = await fx.owner.query<{
      actor_user_id: string | null;
      data: Record<string, unknown>;
    }>(
      `select actor_user_id, data from audit_log where action = 'catalog.updated' and target_id = $1`,
      [appId],
    );
    expect(rows).toEqual([
      { actor_user_id: null, data: expect.objectContaining({ via: 'app_key', appId }) },
    ]);
    const other = await fx.workspace('beta');
    const { token } = await fx.install(other, appId);
    const ev = await fx.request('/v1/events', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'attack.incoming', body: 'x', data: { target: 'Polis 3' } }),
    });
    expect(ev.status).toBe(202);
  });

  it('lets a private app use its installation token', async () => {
    const { token, installationId, appId } = await fx.privateApp(ws);
    expect((await put(token, { types: [attack] })).status).toBe(200);
    const { rows } = await fx.owner.query<{ actor_installation_id: string | null; data: unknown }>(
      `select actor_installation_id, data from audit_log
       where action = 'catalog.updated' and target_id = $1`,
      [appId],
    );
    expect(rows).toEqual([
      {
        actor_installation_id: installationId,
        data: expect.not.objectContaining({ via: 'app_key' }),
      },
    ]);
  });

  it('forbids installation tokens of public apps', async () => {
    const { appId } = await fx.publicApp(ws);
    const other = await fx.workspace('gamma');
    const { token } = await fx.install(other, appId);
    expect((await put(token, { types: [attack] })).status).toBe(403);
  });

  it('rejects invalid payload schemas and reserved keys with 422', async () => {
    const { appKey } = await fx.publicApp(ws);
    expect(
      (await put(appKey, { types: [{ ...attack, payloadSchema: { type: 'nope' } }] })).status,
    ).toBe(422);
    expect((await put(appKey, { types: [{ key: 'generic', name: 'Mine' }] })).status).toBe(422);
    expect((await put(appKey, { types: [{ key: 'owlwire.digest', name: 'Mine' }] })).status).toBe(
      422,
    );
  });

  it('lets a pending public app prepare its catalog and refuses a rejected one', async () => {
    const { appKey, appId } = await fx.publicApp(ws, { approval: 'pending' });
    expect((await put(appKey, { types: [attack] })).status).toBe(200);
    await fx.owner.query(`update apps set approval_status = 'rejected' where id = $1`, [appId]);
    const res = await put(appKey, { types: [attack] });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('app_not_approved');
  });

  it('answers a non-JSON content type like /v1/events does', async () => {
    const { appKey } = await fx.publicApp(ws);
    const res = await put(appKey, { types: [attack] }, 'text/plain');
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('validation_failed');
  });

  it('documents both /v1 write operations in the root OpenAPI document', () => {
    const doc = fx.h.app.getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'test', version: '0' },
    });
    type Op = { security?: unknown[]; requestBody?: { content: Record<string, unknown> } };
    const paths = doc.paths as Record<string, Record<string, Op>>;
    expect(Object.keys(paths['/v1/hooks']?.post?.requestBody?.content ?? {}).sort()).toEqual([
      'application/json',
      'text/plain',
    ]);
    expect(paths['/v1/catalog']?.put?.security).toEqual([
      { appKey: [] },
      { installationToken: [] },
    ]);
  });

  it('takes exactly one rate limit token per request from the app bucket', async () => {
    const { appKey, appId } = await fx.publicApp(ws);
    expect((await put(appKey, { types: [attack] })).status).toBe(200);
    const { rows } = await fx.owner.query<{ tokens: number }>(
      'select tokens from rate_buckets where scope = $1',
      [ingestKeys.app(appId)],
    );
    // The fixture clock stands still, so the bucket does not refill between the two reads.
    expect(rows).toEqual([{ tokens: fx.deps.config.edition.ingest.ratePerMinutePerToken - 1 }]);
  });
});
