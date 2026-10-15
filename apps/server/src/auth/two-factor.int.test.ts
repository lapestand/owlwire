import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  type AuthHarness,
  cookieFrom,
  createAuthHarness,
  extractUrl,
  TEST_PASSWORD,
  type TestUser,
} from '../test/auth-harness.js';
import { nextTotp, totp } from '../test/totp.js';
import { TWO_FACTOR_RATE_LIMIT } from './auth.js';

describe('two factor and passkeys', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  const secrets = new Map<string, string>();
  const hasSessionCookie = (res: Response): boolean =>
    res.headers.getSetCookie().some((c) => /session_token=[^;]+/.test(c));

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
    secrets.set(u.id, secret);
    return { secret, backupCodes };
  };

  /** Signs a TOTP user in with the password and a current code; returns the session cookie. */
  const signInWithTotp = async (u: TestUser): Promise<string> => {
    const challenge = cookieFrom(await h.signInResponse(u.email));
    const res = await h.request('/api/auth/two-factor/verify-totp', {
      body: { code: nextTotp(secrets.get(u.id) ?? '') },
      cookie: challenge,
    });
    expect(res.status).toBe(200);
    return cookieFrom(res);
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
      body: { code: nextTotp(secret) },
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

  it('opens no session from the email verification link, so TOTP is still asked at sign-in', async () => {
    const u = await h.createUser();
    const { secret } = await enableTotp(u);
    // An account that signed up before SMTP was configured: its email is not verified yet.
    await h.harness.ownerPool.query('update auth_user set email_verified = false where id = $1', [
      u.id,
    ]);
    const outboxBefore = h.mailer.outbox.length;
    const send = await h.request('/api/auth/send-verification-email', { body: { email: u.email } });
    expect(send.status).toBe(200);
    const mail = await vi.waitFor(() => {
      const m = h.mailer.outbox.slice(outboxBefore).find((x) => x.to === u.email);
      if (!m) throw new Error('mail not sent yet');
      return m;
    });
    const link = new URL(extractUrl(mail.text));

    const verify = await h.request(`${link.pathname}${link.search}`);
    expect(verify.status).toBeLessThan(400);
    expect(hasSessionCookie(verify)).toBe(false);
    const { rows } = await h.harness.ownerPool.query<{ email_verified: boolean }>(
      'select email_verified from auth_user where id = $1',
      [u.id],
    );
    expect(rows[0]?.email_verified).toBe(true);

    const signIn = await h.signInResponse(u.email);
    expect(hasSessionCookie(signIn)).toBe(false);
    expect(await signIn.json()).toMatchObject({ twoFactorRedirect: true });
    const byTotp = await h.request('/api/auth/two-factor/verify-totp', {
      body: { code: nextTotp(secret) },
      cookie: cookieFrom(signIn),
    });
    expect(byTotp.status).toBe(200);
    expect(hasSessionCookie(byTotp)).toBe(true);
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
      body: { code: nextTotp(secret) },
      cookie,
    });
    expect(ok.status).toBe(200);
  });

  it('locks the account after 10 failed codes across challenges, even for the right code', async () => {
    const u = await h.createUser();
    const { secret, backupCodes } = await enableTotp(u);
    const good = totp(secret, new Date());
    const wrong = good === '000000' ? '111111' : '000000';
    // Each challenge allows 5 attempts; two challenges reach the account limit of 10. Every request comes from a
    // fresh client address, so the per-client rate limit is not what refuses them.
    for (let challenge = 0; challenge < 2; challenge++) {
      const cookie = cookieFrom(await h.signInResponse(u.email));
      for (let i = 0; i < 5; i++) {
        const res = await h.request('/api/auth/two-factor/verify-totp', {
          body: { code: wrong },
          cookie,
        });
        expect(res.status).toBe(401);
      }
    }
    const { rows } = await h.harness.ownerPool.query<{ locked_until: Date | null }>(
      'select locked_until from auth_two_factor where user_id = $1',
      [u.id],
    );
    expect(rows[0]?.locked_until?.getTime()).toBeGreaterThan(Date.now());

    const fresh = cookieFrom(await h.signInResponse(u.email));
    const byTotp = await h.request('/api/auth/two-factor/verify-totp', {
      body: { code: nextTotp(secret) },
      cookie: fresh,
    });
    expect(byTotp.status).toBe(429);
    expect(await byTotp.json()).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_LOCKED' });
    expect(hasSessionCookie(byTotp)).toBe(false);
    const byBackup = await h.request('/api/auth/two-factor/verify-backup-code', {
      body: { code: backupCodes[0] },
      cookie: fresh,
    });
    expect(byBackup.status).toBe(429);
    expect(await byBackup.json()).toMatchObject({ code: 'ACCOUNT_TEMPORARILY_LOCKED' });
    expect(hasSessionCookie(byBackup)).toBe(false);
  });

  describe('single use of a TOTP code', () => {
    const verifyTotp = (cookie: string, code: string) =>
      h.request('/api/auth/two-factor/verify-totp', { body: { code }, cookie });

    it('accepts a sign-in code once', async () => {
      const u = await h.createUser();
      const { secret } = await enableTotp(u);
      const code = nextTotp(secret);
      const first = await verifyTotp(cookieFrom(await h.signInResponse(u.email)), code);
      expect(first.status).toBe(200);
      expect(hasSessionCookie(first)).toBe(true);

      const again = await verifyTotp(cookieFrom(await h.signInResponse(u.email)), code);
      expect(again.status).toBe(401);
      expect(await again.json()).toMatchObject({ code: 'INVALID_CODE' });
      expect(hasSessionCookie(again)).toBe(false);
    });

    it('refuses at sign-in the code that turned TOTP on', async () => {
      const u = await h.createUser();
      const enable = await h.request('/api/auth/two-factor/enable', {
        body: { password: TEST_PASSWORD },
        cookie: u.cookie,
      });
      const { totpURI } = (await enable.json()) as { totpURI: string };
      const secret = new URL(totpURI).searchParams.get('secret') ?? '';
      const code = totp(secret, new Date());
      expect((await verifyTotp(u.cookie, code)).status).toBe(200);

      const challenge = cookieFrom(await h.signInResponse(u.email));
      const reused = await verifyTotp(challenge, code);
      expect(reused.status).toBe(401);
      expect(hasSessionCookie(reused)).toBe(false);
      // The refusal does not end the challenge: the next code still completes it.
      const next = await verifyTotp(challenge, nextTotp(secret));
      expect(next.status).toBe(200);
    });

    it('accepts one of two concurrent uses of the same code', async () => {
      const u = await h.createUser();
      const { secret } = await enableTotp(u);
      const code = nextTotp(secret);
      const challenges = [
        cookieFrom(await h.signInResponse(u.email)),
        cookieFrom(await h.signInResponse(u.email)),
      ];
      const answers = await Promise.all(challenges.map((c) => verifyTotp(c, code)));
      expect(answers.map((r) => r.status).sort()).toEqual([200, 401]);
      expect(answers.filter(hasSessionCookie)).toHaveLength(1);
    });
  });

  describe('disabling TOTP', () => {
    const totpEnabled = async (userId: string): Promise<boolean> => {
      const { rows } = await h.harness.ownerPool.query<{ on: boolean; n: number }>(
        `select u.two_factor_enabled as on,
                (select count(*)::int from auth_two_factor t where t.user_id = u.id) as n
           from auth_user u where u.id = $1`,
        [userId],
      );
      return rows[0]?.on === true && rows[0]?.n === 1;
    };

    it('disables TOTP with the password and a live session', async () => {
      const u = await h.createUser();
      await enableTotp(u);
      // Turning TOTP on replaced the session; sign in again with both factors for a live one.
      const cookie = await signInWithTotp(u);
      const res = await h.request('/api/auth/two-factor/disable', {
        body: { password: TEST_PASSWORD },
        cookie,
      });
      expect(res.status).toBe(200);
      expect(await totpEnabled(u.id)).toBe(false);
    });

    it('refuses a wrong password', async () => {
      const u = await h.createUser();
      await enableTotp(u);
      // Turning TOTP on replaced the session; sign in again with both factors for a live one.
      const cookie = await signInWithTotp(u);
      const res = await h.request('/api/auth/two-factor/disable', {
        body: { password: 'not-the-password' },
        cookie,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'INVALID_PASSWORD' });
      expect(await totpEnabled(u.id)).toBe(true);
    });

    it('refuses a session that was revoked', async () => {
      const u = await h.createUser();
      await enableTotp(u);
      const cookie = await signInWithTotp(u);
      const signOut = await h.request('/api/auth/sign-out', { method: 'POST', body: {}, cookie });
      expect(signOut.status).toBe(200);
      const res = await h.request('/api/auth/two-factor/disable', {
        body: { password: TEST_PASSWORD },
        cookie,
      });
      expect(res.status).toBe(401);
      expect(await totpEnabled(u.id)).toBe(true);
    });

    it('refuses a session that has expired', async () => {
      const u = await h.createUser();
      await enableTotp(u);
      const cookie = await signInWithTotp(u);
      await h.harness.ownerPool.query(
        "update auth_session set expires_at = now() - interval '1 minute' where user_id = $1",
        [u.id],
      );
      const res = await h.request('/api/auth/two-factor/disable', {
        body: { password: TEST_PASSWORD },
        cookie,
      });
      expect(res.status).toBe(401);
      expect(await totpEnabled(u.id)).toBe(true);
    });
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
    expect(
      (body as unknown as { authenticatorSelection: { userVerification: string } })
        .authenticatorSelection.userVerification,
    ).toBe('required');
    expect(body.user.name).toBe(u.email);
  });

  it('asks the authenticator to verify the user at passkey sign-in', async () => {
    const res = await h.request('/api/auth/passkey/generate-authenticate-options');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      challenge: string;
      rpId: string;
      userVerification: string;
    };
    expect(body.challenge.length).toBeGreaterThan(10);
    expect(body.rpId).toBe('localhost');
    expect(body.userVerification).toBe('required');
  });

  it('offers no passkey registration options without a session', async () => {
    const res = await h.request('/api/auth/passkey/generate-register-options');
    expect(res.status).toBe(401);
  });
});
