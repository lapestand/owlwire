import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '@owlwire/core';
import { generateToken } from '@owlwire/crypto';
import {
  AuditDataError,
  InvalidScopeError,
  type OwlwireDb,
  RepoConflictError,
  RepoInputError,
  RepoNotFoundError,
} from '@owlwire/db';
import { HTTPException } from 'hono/http-exception';
import { describe, expect, it, vi } from 'vitest';
import { AUDIT_DATA_DETAIL, INVALID_INPUT_DETAIL, NOT_FOUND_DETAIL } from '../errors.js';
import { ingestEvent } from '../events/ingest.js';
import { createLogger } from '../logger.js';
import {
  authenticateInstallationToken,
  type InstallationAuthResult,
} from '../system/installation-auth.js';
import { type AppDeps, createApp } from './app.js';

// The /v1 router runs for real; only the installation lookup and the event write below it are stubbed, so a
// repository error reaches the app's error handler the way a real one would.
vi.mock('../system/installation-auth.js', () => ({ authenticateInstallationToken: vi.fn() }));
vi.mock('../events/ingest.js', () => ({ ingestEvent: vi.fn() }));

const INSTALLATION = {
  id: '01900000-0000-7000-8000-000000000001',
  appId: '01900000-0000-7000-8000-000000000002',
  workspaceId: '01900000-0000-7000-8000-000000000003',
  grantedTypes: null,
};

const logger = createLogger('silent');

/** Only what the routes under test touch; the auth library is not reached by these requests. */
function makeApp(over: Partial<AppDeps> = {}) {
  return createApp({
    db: {} as OwlwireDb,
    clock: systemClock,
    logger,
    config: { trustedProxies: [] },
    authEnv: { baseURL: 'http://localhost:8080' },
    webDir: null,
    checkReady: async () => true,
    ...over,
  } as unknown as AppDeps);
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

  it('answers repository input and conflict errors on /v1 with fixed details', async () => {
    const app = makeApp();
    vi.mocked(authenticateInstallationToken).mockResolvedValue({
      ok: true,
      installation: INSTALLATION,
    } as InstallationAuthResult);
    vi.mocked(ingestEvent)
      .mockRejectedValueOnce(
        new RepoInputError('event', 'idempotencyKey must be a non-empty string'),
      )
      .mockRejectedValueOnce(
        new RepoConflictError('event', 'events_installation_id_idempotency_key_unique'),
      );
    const send = () =>
      app.request('/v1/events', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${generateToken('inst')}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ type: 'generic', body: 'hello' }),
      });
    try {
      const input = await send();
      expect(input.status).toBe(422);
      expect(input.headers.get('content-type')).toContain('application/problem+json');
      expect(await input.json()).toEqual({
        type: 'https://owlwire.dev/errors/validation_failed',
        title: 'Validation Failed',
        status: 422,
        code: 'validation_failed',
        detail: INVALID_INPUT_DETAIL,
      });
      const conflict = await send();
      expect(conflict.status).toBe(409);
      expect(conflict.headers.get('content-type')).toContain('application/problem+json');
      expect(await conflict.json()).toEqual({
        type: 'https://owlwire.dev/errors/conflict',
        title: 'Conflict',
        status: 409,
        code: 'conflict',
      });
      expect(ingestEvent).toHaveBeenCalledTimes(2);
    } finally {
      vi.mocked(authenticateInstallationToken).mockReset();
      vi.mocked(ingestEvent).mockReset();
    }
  });

  it('maps audit guard errors to 422 validation_failed without echoing input keys', async () => {
    const app = makeApp();
    app.get('/audit', () => {
      throw new AuditDataError(
        'data.myBotTokenSECRETKEY looks like a secret and must not be written to audit_log',
      );
    });
    const res = await app.request('/audit');
    expect(res.status).toBe(422);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const body = await res.json();
    expect(body).toMatchObject({
      code: 'validation_failed',
      status: 422,
      detail: AUDIT_DATA_DETAIL,
    });
    expect(JSON.stringify(body)).not.toContain('SECRETKEY');
  });

  it('maps repository not-found and invalid scope errors to a 404 problem with a fixed detail', async () => {
    const secretId = 'SECRET-ID-6012345678';
    const app = makeApp();
    app.get('/missing', () => {
      throw new RepoNotFoundError('connection', secretId);
    });
    app.get('/scope', () => {
      throw new InvalidScopeError(`workspaceId must be a UUID: ${secretId}`);
    });
    for (const path of ['/missing', '/scope']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      const text = await res.text();
      expect(text).not.toContain(secretId);
      expect(text).not.toContain('connection');
      expect(JSON.parse(text)).toEqual({
        type: 'https://owlwire.dev/errors/not_found',
        title: 'Not Found',
        status: 404,
        code: 'not_found',
        detail: NOT_FOUND_DETAIL,
      });
    }
  });

  it('logs unhandled errors without query parameters', async () => {
    const lines: string[] = [];
    const app = makeApp({
      logger: createLogger('error', { write: (line: string) => void lines.push(line) }),
    });
    app.get('/query', () => {
      throw new Error('Failed query: select 1 where token = $1\nparams: hunter2-secret');
    });
    expect((await app.request('/query')).status).toBe(500);
    expect(lines.join('')).toContain('Failed query');
    expect(lines.join('')).not.toContain('hunter2-secret');
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
