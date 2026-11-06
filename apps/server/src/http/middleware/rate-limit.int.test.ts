import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemError } from '../../errors.js';
import {
  BATCH_OVER_RATE_LIMIT_DETAIL,
  consumeIngestBatchRemainder,
  ingestKeys,
} from '../../system/rate-limit.js';
import { type AppFixture, createAppFixture } from '../../test/app-fixtures.js';
import { problem } from '../problem.js';
import { V1_BODY_LIMIT_BYTES, v1BodyLimit } from '../routes/v1/index.js';
import type { AppEnv } from '../types.js';
import { installationAuth } from './installation-auth.js';
import { ingestRateLimit } from './rate-limit.js';
import { requestId } from './request-id.js';

let fx: AppFixture;
let mini: Hono<AppEnv>;
let ws: string;

beforeAll(async () => {
  fx = await createAppFixture();
  ws = await fx.workspace('alpha');
  mini = new Hono<AppEnv>();
  // As in the real app: the request logger is in place before the auth middleware runs.
  mini.use('*', requestId(fx.deps.logger));
  mini.onError((err, c) =>
    err instanceof ProblemError ? problem(c, err) : c.text(String(err), 500),
  );
  mini.use(
    '/limited',
    installationAuth(fx.deps.db, { allowQueryToken: false }),
    ingestRateLimit(fx.deps, (c) => ingestKeys.installation(c.get('installation').installationId)),
  );
  mini.post('/limited', (c) => c.json({ ok: true }));
  // Stands in for a batch handler: the batch size comes in the query instead of a parsed body.
  mini.use(
    '/batch',
    installationAuth(fx.deps.db, { allowQueryToken: false }),
    ingestRateLimit(fx.deps, (c) => ingestKeys.installation(c.get('installation').installationId)),
  );
  mini.post('/batch', async (c) => {
    const key = ingestKeys.installation(c.get('installation').installationId);
    await consumeIngestBatchRemainder(fx.deps, key, Number(c.req.query('n')));
    return c.json({ ok: true });
  });
  mini.use('/body', v1BodyLimit());
  mini.post('/body', async (c) => c.json({ length: (await c.req.text()).length }));
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

const ingest = () => fx.deps.config.edition.ingest;

function chunkedBody(totalBytes: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const n = Math.min(4096, totalBytes - sent);
      controller.enqueue(new Uint8Array(n).fill(97));
      sent += n;
    },
  });
}

describe('ingestRateLimit', () => {
  it('returns 429 with Retry-After once the per-minute budget is spent', async () => {
    const prev = ingest().ratePerMinutePerToken;
    ingest().ratePerMinutePerToken = 3;
    try {
      const { token } = await fx.privateApp(ws);
      const send = () =>
        mini.request('/limited', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      expect((await send()).status).toBe(200);
      const limited = await send();
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBe('20');
      expect(((await limited.json()) as { code: string }).code).toBe('rate_limited');
      fx.clock.advance(20_000);
      expect((await send()).status).toBe(200);
    } finally {
      ingest().ratePerMinutePerToken = prev;
    }
  });

  it('keeps a separate budget per installation', async () => {
    const prev = ingest().ratePerMinutePerToken;
    ingest().ratePerMinutePerToken = 1;
    try {
      const a = await fx.privateApp(ws);
      const b = await fx.privateApp(ws);
      const send = (token: string) =>
        mini.request('/limited', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      expect((await send(a.token)).status).toBe(200);
      expect((await send(a.token)).status).toBe(429);
      expect((await send(b.token)).status).toBe(200);
    } finally {
      ingest().ratePerMinutePerToken = prev;
    }
  });

  it('is disabled when the limit is zero', async () => {
    const prev = ingest().ratePerMinutePerToken;
    ingest().ratePerMinutePerToken = 0;
    try {
      const { token } = await fx.privateApp(ws);
      for (let i = 0; i < 5; i++) {
        const res = await mini.request('/limited', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
      }
    } finally {
      ingest().ratePerMinutePerToken = prev;
    }
  });
});

describe('consumeIngestBatchRemainder', () => {
  const sendBatch = (token: string, n: number) =>
    mini.request(`/batch?n=${n}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
  const tokensLeft = async (installationId: string) => {
    const r = await fx.owner.query<{ tokens: number }>(
      'select tokens from rate_buckets where scope = $1',
      [ingestKeys.installation(installationId)],
    );
    return r.rows[0]?.tokens;
  };

  it('refuses a batch larger than the bucket capacity with 422 and takes no tokens', async () => {
    const prev = ingest().ratePerMinutePerToken;
    ingest().ratePerMinutePerToken = 50;
    try {
      const { token, installationId } = await fx.privateApp(ws);
      const res = await sendBatch(token, 100);
      expect(res.status).toBe(422);
      const body = (await res.json()) as { code: string; detail: string };
      expect(body).toMatchObject({
        code: 'validation_failed',
        detail: BATCH_OVER_RATE_LIMIT_DETAIL,
      });
      expect(await tokensLeft(installationId)).toBe(50);
    } finally {
      ingest().ratePerMinutePerToken = prev;
    }
  });

  it('takes the whole batch cost exactly when it fits', async () => {
    const prev = ingest().ratePerMinutePerToken;
    ingest().ratePerMinutePerToken = 50;
    try {
      const { token, installationId } = await fx.privateApp(ws);
      expect((await sendBatch(token, 40)).status).toBe(200);
      expect(await tokensLeft(installationId)).toBe(10);
      const limited = await sendBatch(token, 40);
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    } finally {
      ingest().ratePerMinutePerToken = prev;
    }
  });

  it('does not drain the bucket when over-capacity batches are retried', async () => {
    const prev = ingest().ratePerMinutePerToken;
    ingest().ratePerMinutePerToken = 5;
    try {
      const { token, installationId } = await fx.privateApp(ws);
      for (let i = 0; i < 10; i++) expect((await sendBatch(token, 6)).status).toBe(422);
      expect(await tokensLeft(installationId)).toBe(5);
      expect((await sendBatch(token, 5)).status).toBe(200);
      expect(await tokensLeft(installationId)).toBe(0);
    } finally {
      ingest().ratePerMinutePerToken = prev;
    }
  });
});

describe('v1BodyLimit', () => {
  it('passes bodies within 64 KiB unchanged', async () => {
    const res = await mini.request('/body', {
      method: 'POST',
      body: 'a'.repeat(V1_BODY_LIMIT_BYTES),
    });
    expect(await res.json()).toEqual({ length: V1_BODY_LIMIT_BYTES });
  });

  it('rejects a declared Content-Length above the limit', async () => {
    const size = V1_BODY_LIMIT_BYTES + 1;
    const res = await mini.request('/body', {
      method: 'POST',
      headers: { 'content-length': String(size) },
      body: 'a'.repeat(size),
    });
    expect(res.status).toBe(413);
    expect(((await res.json()) as { code: string }).code).toBe('payload_too_large');
  });

  it('rejects oversized chunked bodies without Content-Length', async () => {
    const res = await mini.request('/body', {
      method: 'POST',
      body: chunkedBody(V1_BODY_LIMIT_BYTES * 4),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
  });
});
