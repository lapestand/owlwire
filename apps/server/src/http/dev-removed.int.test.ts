import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDefaultAdapters, createAdapterRegistry } from '../adapters/registry.js';
import { loadConfig } from '../config/load.js';
import { type AuthHarness, createAuthHarness, TEST_BASE_URL } from '../test/auth-harness.js';
import { TEST_AUTH_SECRET } from '../test/config.js';
import { createApp } from './app.js';

const noop = () => undefined;
const DEV_TOKEN = 'dev-admin-token-for-tests-0001';

describe('removed development endpoints', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it.each(['/api/dev/deliveries', '/api/dev/events', '/api/dev/seed'])(
    '%s is gone',
    async (path) => {
      const res = await h.request(path, { headers: { authorization: 'Bearer anything' } });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
    },
  );

  it('is gone for a signed-in user too', async () => {
    const user = await h.createUser();
    const res = await h.request('/api/dev/deliveries', { cookie: user.cookie });
    expect(res.status).toBe(404);
  });

  it('still asks for a session on an existing route', async () => {
    expect((await h.request('/api/me')).status).toBe(401);
  });

  it('ignores the removed variables when the server is configured', async () => {
    const config = loadConfig(
      {
        OWLWIRE_DATABASE_URL: 'postgres://u:p@localhost:5432/owlwire',
        OWLWIRE_KEK: randomBytes(32).toString('base64'),
        OWLWIRE_AUTH_SECRET: TEST_AUTH_SECRET,
        OWLWIRE_DEV_ADMIN_TOKEN: DEV_TOKEN,
        OWLWIRE_DEV_FAKE_ADAPTER: '1',
      },
      () => null,
    );
    expect(config).not.toHaveProperty('devAdminToken');
    expect(config).not.toHaveProperty('devFakeAdapter');

    const adapters = createAdapterRegistry(
      buildDefaultAdapters(config, {
        logger: { info: noop, warn: noop, error: noop, debug: noop },
        fetch: globalThis.fetch,
        clock: h.deps.clock,
      }),
    );
    expect(adapters.list().map((a) => a.platform)).toEqual(['telegram']);

    const app = createApp({ ...h.deps, config, webDir: null });
    const res = await app.request(`${TEST_BASE_URL}/api/dev/deliveries`, {
      headers: { authorization: `Bearer ${DEV_TOKEN}`, origin: TEST_BASE_URL },
    });
    expect(res.status).toBe(404);
  });
});
