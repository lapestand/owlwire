import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '@owlwire/core';
import type { Db } from '@owlwire/db';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { type AppDeps, createApp } from './app.js';

const logger = createLogger('silent');

function makeApp(over: Partial<AppDeps> = {}) {
  return createApp({
    db: {} as Db,
    clock: systemClock,
    logger,
    config: { devAdminToken: null },
    webDir: null,
    checkReady: async () => true,
    ...over,
  });
}

describe('health', () => {
  it('answers /healthz with ok', async () => {
    const res = await makeApp().request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('answers /readyz with 200 when ready and 503 problem details otherwise', async () => {
    expect((await makeApp().request('/readyz')).status).toBe(200);
    const down = await makeApp({ checkReady: async () => false }).request('/readyz');
    expect(down.status).toBe(503);
    expect(down.headers.get('content-type')).toContain('application/problem+json');
    expect(((await down.json()) as { code: string }).code).toBe('unavailable');
    const failing = await makeApp({
      checkReady: async () => {
        throw new Error('connection refused');
      },
    }).request('/readyz');
    expect(failing.status).toBe(503);
    expect(((await failing.json()) as { code: string }).code).toBe('unavailable');
  });
});

describe('request id', () => {
  it('echoes a well-formed x-request-id and replaces a malformed one', async () => {
    const app = makeApp();
    const ok = await app.request('/healthz', { headers: { 'x-request-id': 'abc-123' } });
    expect(ok.headers.get('x-request-id')).toBe('abc-123');
    const bad = await app.request('/healthz', { headers: { 'x-request-id': 'bad id\n' } });
    expect(bad.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('errors', () => {
  it('returns RFC 9457 problem details for unknown routes', async () => {
    const res = await makeApp().request('/v1/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(res.headers.get('x-request-id')).toBeTruthy();
    expect(await res.json()).toEqual({
      type: 'https://owlwire.dev/errors/not_found',
      title: 'Not Found',
      status: 404,
      code: 'not_found',
    });
  });

  it('hides internal error details', async () => {
    const app = makeApp();
    app.get('/boom', () => {
      throw new Error('db password is hunter2');
    });
    const res = await app.request('/boom');
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text).code).toBe('internal');
  });

  it('maps a 400 HTTPException such as a malformed JSON body to validation_failed', async () => {
    const app = makeApp();
    app.post('/parse', () => {
      throw new HTTPException(400, { message: 'Malformed JSON in request body' });
    });
    const res = await app.request('/parse', { method: 'POST', body: '{not json' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(((await res.json()) as { code: string }).code).toBe('validation_failed');
  });
});

describe('static ui', () => {
  const root = mkdtempSync(join(tmpdir(), 'web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>owlwire</title>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log(1)');
  const app = makeApp({ webDir: root });

  it('serves index.html, assets and an SPA fallback', async () => {
    const index = await app.request('/');
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('owlwire');
    const js = await app.request('/assets/app.js');
    expect(js.headers.get('content-type')).toContain('text/javascript');
    const deep = await app.request('/deliveries/123');
    expect(await deep.text()).toContain('owlwire');
  });

  it('refuses path traversal', async () => {
    const res = await app.request('/..%2f..%2f..%2fetc%2fpasswd');
    expect(res.status).toBe(404);
  });

  it('mounts the v1 api ahead of the static handler', async () => {
    const res = await app.request('/v1/events', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });

  it('never answers api paths with html', async () => {
    const res = await app.request('/v1/unknown');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });
});
