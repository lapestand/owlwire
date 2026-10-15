import { describe, expect, it, vi } from 'vitest';

vi.mock('./users.js', () => ({ countInstanceAdmins: async () => 1 }));
vi.mock('./registration.js', () => ({ getRegistrationMode: async () => 'closed' }));

const { collectAuthStartupWarnings } = await import('./auth-warnings.js');

const deps = {
  db: {} as never,
  authDb: {} as never,
  config: { trustedProxies: [] } as never,
  mailer: { send: async () => {} },
  authEnv: {
    secret: 'x'.repeat(32),
    baseURL: 'http://localhost:8080',
    publicUrlConfigured: true,
    smtp: null,
    social: { discord: null, google: null, github: null },
  },
};

describe('collectAuthStartupWarnings', () => {
  it('warns when the removed dev admin token is still set', async () => {
    const warnings = await collectAuthStartupWarnings(deps, { OWLWIRE_DEV_ADMIN_TOKEN: 'old' });
    expect(warnings).toContain(
      'OWLWIRE_DEV_ADMIN_TOKEN is no longer used and grants nothing; remove it from your environment.',
    );
  });

  it('warns when the removed dev fake adapter flag is still set', async () => {
    const warnings = await collectAuthStartupWarnings(deps, { OWLWIRE_DEV_FAKE_ADAPTER: '1' });
    expect(warnings).toContain(
      'OWLWIRE_DEV_FAKE_ADAPTER is no longer used; remove it from your environment.',
    );
  });

  it('names the removed settings, never their values', async () => {
    const warnings = await collectAuthStartupWarnings(deps, {
      OWLWIRE_DEV_ADMIN_TOKEN: 'old-token-value-0001',
      OWLWIRE_DEV_FAKE_ADAPTER: '1',
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).not.toContain('old-token-value-0001');
  });

  it('stays quiet when everything is configured', async () => {
    expect(await collectAuthStartupWarnings(deps, {})).toEqual([]);
  });
});
