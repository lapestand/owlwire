import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthHarness,
  cookieFrom,
  createAuthHarness,
  TEST_PASSWORD,
  type TestUser,
} from '../test/auth-harness.js';
import { totp } from '../test/totp.js';
import { TWO_FACTOR_RATE_LIMIT } from './auth.js';

describe('two factor and passkeys', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  /** Enables TOTP for the user and confirms it with a first code; returns the base32 secret and backup codes. */
  const enableTotp = async (u: TestUser): Promise<{ secret: string; backupCodes: string[] }> => {
    const enable = await h.request('/api/auth/two-factor/enable', {
      body: { password: TEST_PASSWORD },
      cookie: u.cookie,
    });
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = (await enable.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    const secret = new URL(totpURI).searchParams.get('secret') ?? '';
    const verify = await h.request('/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret, new Date()) },
      cookie: u.cookie,
    });
    expect(verify.status).toBe(200);
    return { secret, backupCodes };
  };

  it('enables TOTP and then requires a second factor at sign-in', async () => {
    const u = await h.createUser();
    const enable = await h.request('/api/auth/two-factor/enable', {
      body: { password: TEST_PASSWORD },
      cookie: u.cookie,
    });
    expect(enable.status).toBe(200);
    const { totpURI, backupCodes } = (await enable.json()) as {
      totpURI: string;
      backupCodes: string[];
    };
    expect(backupCodes.length).toBeGreaterThan(0);
    expect(new URL(totpURI).searchParams.get('issuer')).toBe('Owlwire');
    const secret = new URL(totpURI).searchParams.get('secret') ?? '';
    const verify = await h.request('/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret, new Date()) },
      cookie: u.cookie,
    });
    expect(verify.status).toBe(200);
    const signIn = await h.signInResponse(u.email);
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
  });

  it('refuses to enable TOTP without the account password', async () => {
    const u = await h.createUser();
    const res = await h.request('/api/auth/two-factor/enable', {
      body: { password: 'not-the-password' },
      cookie: u.cookie,
    });
    expect(res.status).toBe(400);
    const { rows } = await h.harness.ownerPool.query(
      'select 1 from auth_two_factor where user_id = $1',
      [u.id],
    );
    expect(rows).toHaveLength(0);
  });

  it('stores the TOTP secret and the backup codes only encrypted', async () => {
    const u = await h.createUser();
    const { secret, backupCodes } = await enableTotp(u);
    const { rows } = await h.harness.ownerPool.query<{ secret: string; backup_codes: string }>(
      'select secret, backup_codes from auth_two_factor where user_id = $1',
      [u.id],
    );
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row?.secret).not.toContain(secret);
    for (const code of backupCodes) expect(row?.backup_codes).not.toContain(code);
  });

  it('completes the sign-in with a TOTP code and with a backup code', async () => {
    const u = await h.createUser();
    const { secret, backupCodes } = await enableTotp(u);

    const first = await h.signInResponse(u.email);
    expect(first.headers.getSetCookie().some((c) => /session_token=[^;]+/.test(c))).toBe(false);
    const byTotp = await h.request('/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret, new Date()) },
      cookie: cookieFrom(first),
    });
    expect(byTotp.status).toBe(200);
    const session = await h.request('/api/auth/get-session', { cookie: cookieFrom(byTotp) });
    expect(((await session.json()) as { user: { id: string } }).user.id).toBe(u.id);

    const second = await h.signInResponse(u.email);
    const byBackup = await h.request('/api/auth/two-factor/verify-backup-code', {
      body: { code: backupCodes[0] },
      cookie: cookieFrom(second),
    });
    expect(byBackup.status).toBe(200);
    // A backup code works once.
    const third = await h.signInResponse(u.email);
    const reused = await h.request('/api/auth/two-factor/verify-backup-code', {
      body: { code: backupCodes[0] },
      cookie: cookieFrom(third),
    });
    expect(reused.status).toBe(401);
  });

  it('refuses a wrong code and rate limits second-factor attempts per client', async () => {
    const u = await h.createUser();
    const { secret } = await enableTotp(u);
    const signIn = await h.signInResponse(u.email);
    const cookie = cookieFrom(signIn);
    const good = totp(secret, new Date());
    const wrong = good === '000000' ? '111111' : '000000';
    const remoteAddress = '10.201.0.7';
    const statuses: number[] = [];
    const { max } = TWO_FACTOR_RATE_LIMIT;
    for (let i = 0; i <= max; i++) {
      const res = await h.request('/api/auth/two-factor/verify-totp', {
        body: { code: wrong },
        cookie,
        remoteAddress,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, max).every((s) => s === 401)).toBe(true);
    expect(statuses[max]).toBe(429);
    // The limit is per client: the right code from another address still completes the sign-in.
    const ok = await h.request('/api/auth/two-factor/verify-totp', {
      body: { code: totp(secret, new Date()) },
      cookie,
    });
    expect(ok.status).toBe(200);
  });

  it('does not send OTP codes: no delivery channel is configured', async () => {
    const u = await h.createUser();
    const res = await h.request('/api/auth/two-factor/enable', {
      body: { password: TEST_PASSWORD, method: 'otp' },
      cookie: u.cookie,
    });
    expect(res.status).toBe(400);
  });

  it('offers passkey registration options to a signed-in user', async () => {
    const u = await h.createUser();
    const res = await h.request('/api/auth/passkey/generate-register-options', {
      cookie: u.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      challenge: string;
      rp: { id: string; name: string };
      user: { name: string };
    };
    expect(body.challenge.length).toBeGreaterThan(10);
    expect(body.rp).toMatchObject({ id: 'localhost', name: 'Owlwire' });
    expect(body.user.name).toBe(u.email);
  });

  it('offers no passkey registration options without a session', async () => {
    const res = await h.request('/api/auth/passkey/generate-register-options');
    expect(res.status).toBe(401);
  });
});
