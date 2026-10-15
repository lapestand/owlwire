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
    smtp: null as { url: string; from: string } | null,
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

  const withAuthEnv = (patch: Partial<typeof deps.authEnv>) => ({
    ...deps,
    authEnv: { ...deps.authEnv, ...patch },
  });
  const prod = { NODE_ENV: 'production' };
  const smtpUrl = 'smtp://mailer:s3cret-pass@mail.example:587';

  it('says the public URL is not set, rather than not https, when it is missing in production', async () => {
    const unset = await collectAuthStartupWarnings(
      withAuthEnv({ publicUrlConfigured: false }),
      prod,
    );
    expect(unset).toEqual([expect.stringMatching(/^OWLWIRE_PUBLIC_URL is not set in production/)]);
    const http = await collectAuthStartupWarnings(
      withAuthEnv({ baseURL: 'http://owlwire.example' }),
      prod,
    );
    expect(http).toEqual([expect.stringMatching(/^OWLWIRE_PUBLIC_URL is not https in production/)]);
  });

  it.each(['https://192.0.2.10', 'https://192.0.2.10:8443/owlwire', 'http://[2001:db8::1]:8080'])(
    'warns that passkeys cannot work on the IP address public URL %s',
    async (baseURL) => {
      const warnings = await collectAuthStartupWarnings(
        { ...withAuthEnv({ baseURL }), config: { trustedProxies: ['10.0.0.1'] } as never },
        {},
      );
      expect(warnings).toEqual([
        'OWLWIRE_PUBLIC_URL uses an IP address as its host: passkeys need a domain name (localhost works ' +
          'for local testing), so passkey sign-up and sign-in will fail. Use a domain name.',
      ]);
    },
  );

  it('does not warn about passkeys for a domain name or localhost', async () => {
    for (const baseURL of ['http://localhost:8080', 'http://owlwire.example']) {
      expect(await collectAuthStartupWarnings(withAuthEnv({ baseURL }), {})).toEqual([]);
    }
  });

  it('warns about SMTP without required TLS in production, without the URL', async () => {
    // An https public URL behind a listed proxy: the only warning left is the SMTP one.
    const smtp = (url: string) =>
      collectAuthStartupWarnings(
        {
          ...withAuthEnv({ baseURL: 'https://owlwire.example', smtp: { url, from: 'a@x.test' } }),
          config: { trustedProxies: ['10.0.0.1'] } as never,
        },
        prod,
      );
    const warnings = await smtp(smtpUrl);
    expect(warnings).toEqual([
      'OWLWIRE_SMTP_URL is smtp:// without requireTLS in production: STARTTLS is optional, so an attacker on ' +
        'the network can downgrade the connection and read sign-in links and the SMTP password. Use smtps://, ' +
        'or add ?requireTLS=true to the URL.',
    ]);
    expect(warnings.join('\n')).not.toMatch(/s3cret|mailer:|mail\.example/);
    expect(await smtp(`${smtpUrl}?ignoreTLS=true`)).toHaveLength(1);
    expect(await smtp(`${smtpUrl}?requireTLS=false`)).toHaveLength(1);
    expect(await smtp(`${smtpUrl}?requireTLS=true`)).toEqual([]);
    expect(await smtp(`${smtpUrl}?pool=true&requireTLS=TRUE`)).toEqual([]);
    expect(await smtp('smtps://mailer:s3cret-pass@mail.example:465')).toEqual([]);
    // Outside production the same URL is fine (a local mail catcher rarely speaks TLS).
    expect(
      await collectAuthStartupWarnings(
        withAuthEnv({ smtp: { url: smtpUrl, from: 'a@x.test' } }),
        {},
      ),
    ).toEqual([]);
  });

  it('stays quiet when everything is configured', async () => {
    expect(await collectAuthStartupWarnings(deps, {})).toEqual([]);
  });
});
