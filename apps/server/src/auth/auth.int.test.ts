import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProblemError } from '../errors.js';
import { sessionAuth } from '../http/middleware/session-auth.js';
import { problem } from '../http/problem.js';
import type { ApiEnv } from '../http/routes/api/env.js';
import { createLogger } from '../logger.js';
import {
  createMemoryMailer,
  type Mailer,
  type MailMessage,
  MailMessageError,
} from '../mail/mailer.js';
import { MailTemplateError } from '../mail/templates.js';
import { countInstanceAdmins, findUserByEmail, findUserById } from '../system/users.js';
import {
  type AuthHarness,
  cookieFrom,
  createAuthHarness,
  extractUrl,
  TEST_BASE_URL,
  TEST_PASSWORD,
  uniqueEmail,
} from '../test/auth-harness.js';
import { TEST_AUTH_SECRET, testAuthEnv } from '../test/config.js';
import {
  AUTH_CLIENT_IP_HEADER,
  AUTH_COOKIE_PREFIX,
  AUTH_RATE_LIMIT,
  createAuth,
  EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
  MIN_PASSWORD_LENGTH,
  noopAuthHooks,
  RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
  RegistrationDeniedError,
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_UPDATE_AGE_SECONDS,
  SIGN_IN_RATE_LIMIT,
  secureCookiesFor,
} from './auth.js';
import { runAsBootstrap } from './bootstrap-context.js';

/** A pino logger whose JSON lines land in `lines`. */
function captureLogger() {
  const lines: string[] = [];
  const logger = createLogger('debug', { write: (line: string) => void lines.push(line) });
  return { lines, logger };
}

/** Auth mail is sent in the background, after the response: wait for the message to arrive. */
async function mailTo(outbox: MailMessage[], to: string, subject?: string): Promise<MailMessage> {
  return vi.waitFor(() => {
    const mail = outbox.filter((m) => m.to === to && (!subject || m.subject === subject)).at(-1);
    if (!mail) throw new Error('mail not sent yet');
    return mail;
  });
}

/** Logs from background mail sends land after the response. */
async function logged(lines: string[], text: string): Promise<string> {
  return vi.waitFor(() => {
    const log = lines.join('\n');
    if (!log.includes(text)) throw new Error('not logged yet');
    return log;
  });
}

/** What a sign-up response reveals: the token (always null) and the user fields present. */
async function responseShape(res: Response): Promise<{ token: unknown; keys: string[] }> {
  const b = (await res.json()) as { token: unknown; user: Record<string, unknown> };
  return { token: b.token, keys: Object.keys(b.user).sort() };
}

const sessionCookie = (res: Response) =>
  res.headers.getSetCookie().find((c) => c.includes(`${AUTH_COOKIE_PREFIX}.session_token=`)) ?? '';

describe('better auth with smtp', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('issues an owlwire-prefixed session cookie and exposes the session', async () => {
    const u = await h.createUser();
    expect(u.cookie).toContain('owlwire.session_token=');
    const res = await h.request('/api/auth/get-session', { cookie: u.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { email: string; isInstanceAdmin: boolean } };
    expect(body.user.email).toBe(u.email);
    expect(body.user.isInstanceAdmin).toBe(false);
  });

  it('marks the session cookie HttpOnly and SameSite=Lax', async () => {
    const res = await h.signInResponse((await h.createUser()).email);
    const cookie = sessionCookie(res);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
  });

  it('requires email verification before sign-in', async () => {
    const email = uniqueEmail('verify');
    expect((await h.signUp(email)).status).toBe(200);
    expect((await h.signInResponse(email)).status).toBe(403);
    const mail = await mailTo(h.mailer.outbox, email);
    expect(mail.subject).toBe('Verify your Owlwire email address');
    const link = new URL(extractUrl(mail.text));
    expect(link.origin).toBe(TEST_BASE_URL);
    expect(link.pathname).toBe('/api/auth/verify-email');
    expect(link.searchParams.get('callbackURL')).toBe(`${TEST_BASE_URL}/`);
    const verify = await h.request(`${link.pathname}${link.search}`);
    expect(verify.status).toBeLessThan(400);
    expect((await h.signInResponse(email)).status).toBe(200);
  });

  it('opens no session from the email verification link', async () => {
    const email = uniqueEmail('verify-nosession');
    expect((await h.signUp(email)).status).toBe(200);
    const link = new URL(extractUrl((await mailTo(h.mailer.outbox, email)).text));
    const verify = await h.request(`${link.pathname}${link.search}`);
    expect(verify.status).toBeLessThan(400);
    expect(sessionCookie(verify)).toBe('');
    expect((await h.signInResponse(email)).status).toBe(200);
  });

  it('localizes the verification email from accept-language', async () => {
    const email = uniqueEmail('tr');
    await h.request('/api/auth/sign-up/email', {
      body: { email, password: TEST_PASSWORD, name: 'Ayşe' },
      headers: { 'accept-language': 'tr-TR,tr;q=0.9' },
    });
    const mail = await mailTo(h.mailer.outbox, email);
    expect(mail.subject).toBe('Owlwire e-posta adresinizi doğrulayın');
  });

  it('ignores a client-provided isInstanceAdmin field', async () => {
    const email = uniqueEmail('sneaky');
    await h.request('/api/auth/sign-up/email', {
      body: { email, password: TEST_PASSWORD, name: 'Sneaky', isInstanceAdmin: true },
    });
    const user = await findUserByEmail(h.deps, email);
    expect(user?.isInstanceAdmin ?? false).toBe(false);
  });

  it('resets the password through the emailed link', async () => {
    const u = await h.createUser(uniqueEmail('reset'));
    const res = await h.request('/api/auth/request-password-reset', {
      body: { email: u.email, redirectTo: `${TEST_BASE_URL}/reset-password` },
    });
    expect(res.status).toBe(200);
    const mail = await mailTo(h.mailer.outbox, u.email, 'Reset your Owlwire password');
    expect(RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS).toBe(3600);
    expect(mail.text).toContain('1 hour');
    const link = new URL(extractUrl(mail.text));
    expect(link.searchParams.get('callbackURL')).toBe(`${TEST_BASE_URL}/reset-password`);
    const token = link.pathname.split('/').pop() ?? '';
    const done = await h.request('/api/auth/reset-password', {
      body: { newPassword: 'another-long-password', token },
    });
    expect(done.status).toBe(200);
    expect((await h.signInResponse(u.email, TEST_PASSWORD)).status).toBe(401);
    expect((await h.signInResponse(u.email, 'another-long-password')).status).toBe(200);
  });

  it('stores the reset token only as a hash', async () => {
    const u = await h.createUser(uniqueEmail('hashed'));
    await h.request('/api/auth/request-password-reset', {
      body: { email: u.email, redirectTo: `${TEST_BASE_URL}/reset-password` },
    });
    const mail = await mailTo(h.mailer.outbox, u.email, 'Reset your Owlwire password');
    const token = new URL(extractUrl(mail.text)).pathname.split('/').pop() ?? '';
    expect(token.length).toBeGreaterThan(10);
    const { rows } = await h.harness.ownerPool.query<{ identifier: string }>(
      'select identifier from auth_verification',
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.identifier).not.toContain(token);
  });

  it('rejects passwords shorter than the minimum', async () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    const short = await h.signUp(uniqueEmail('short'), {
      password: 'p'.repeat(MIN_PASSWORD_LENGTH - 1),
    });
    expect(short.status).toBe(400);
    const exact = await h.signUp(uniqueEmail('exact'), {
      password: 'p'.repeat(MIN_PASSWORD_LENGTH),
    });
    expect(exact.status).toBe(200);
  });

  it('sends no verification email for a user created in the bootstrap context', async () => {
    const email = uniqueEmail('bootstrap');
    const before = h.mailer.outbox.length;
    await runAsBootstrap(() =>
      h.deps.auth.api.signUpEmail({ body: { email, password: TEST_PASSWORD, name: 'Admin' } }),
    );
    expect(h.mailer.outbox.slice(before).filter((m) => m.to === email)).toEqual([]);
    expect(await findUserByEmail(h.deps, email)).not.toBeNull();
  });
});

describe('better auth on the auth database role', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ smtp: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it('signs up and in through the auth role while the application role gets 42501 on the secrets', async () => {
    const before = await countInstanceAdmins(h.deps);
    const u = await h.createUser(uniqueEmail('authrole'));
    expect(cookieFrom(await h.signInResponse(u.email))).toContain('owlwire.session_token=');
    expect(await findUserById(h.deps, u.id)).toMatchObject({
      email: u.email,
      isInstanceAdmin: false,
      twoFactorEnabled: false,
    });
    expect(await countInstanceAdmins(h.deps)).toBe(before);
    const { rows } = await h.harness.ownerPool.query(
      'select count(*)::int as n from auth_session s join auth_user u on u.id = s.user_id where u.email = $1',
      [u.email],
    );
    // Sign-up opens no session: one from createUser's sign-in, one from the sign-in above.
    expect(rows[0]).toEqual({ n: 2 });
    // deps.pool connects as the application role.
    for (const query of [
      'select * from auth_session limit 1',
      'select * from auth_account limit 1',
      'select * from auth_verification limit 1',
      'select * from auth_rate_limit limit 1',
    ]) {
      await expect(h.deps.pool.query(query)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      h.deps.pool.query('select id, name, email from auth_user where email = $1', [u.email]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});

describe('better auth without smtp', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ smtp: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it('signs in separately after sign-up, without email verification and without email', async () => {
    const email = uniqueEmail('nosmtp');
    const signUp = await h.signUp(email);
    expect(signUp.status).toBe(200);
    expect(sessionCookie(signUp)).toBe('');
    expect(((await signUp.json()) as { token: unknown }).token).toBeNull();
    expect((await h.signInResponse(email)).status).toBe(200);
    expect(h.mailer.outbox).toHaveLength(0);
  });

  it('answers a sign-up for a taken email like a new one', async () => {
    const taken = await h.createUser(uniqueEmail('nosmtp-taken'));
    const again = await h.signUp(taken.email);
    const fresh = await h.signUp(uniqueEmail('nosmtp-fresh'));
    expect(again.status).toBe(200);
    expect(fresh.status).toBe(200);
    expect(await responseShape(again)).toEqual(await responseShape(fresh));
  });
});

describe('better auth with a failing smtp server', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({
      mailer: {
        async send() {
          throw new Error('smtp down');
        },
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('still creates the account when the verification email fails', async () => {
    const email = uniqueEmail('smtpdown');
    expect((await h.signUp(email)).status).toBe(200);
    expect(await findUserByEmail(h.deps, email)).not.toBeNull();
  });
});

describe('auth email failures', () => {
  let h: AuthHarness;
  // Sign-ups are rate limited per address (a few per ten seconds); each call below is its own client.
  let lastOctet = 0;
  const nextIp = () => `192.0.2.${100 + (lastOctet++ % 100)}`;
  beforeAll(async () => {
    h = await createAuthHarness({ smtp: false });
  });
  afterAll(async () => {
    await h.close();
  });

  // allowHttpLinks false is what loadConfig sets under NODE_ENV=production.
  const signUpWith = async (
    send: Mailer['send'],
    allowHttpLinks = true,
    baseURL = TEST_BASE_URL,
  ) => {
    const { lines, logger } = captureLogger();
    const auth = createAuth({
      db: h.deps.authDb,
      env: testAuthEnv({
        smtp: true,
        env: { OWLWIRE_PUBLIC_URL: baseURL },
      }),
      mailer: { send },
      logger,
      hooks: noopAuthHooks,
      allowHttpLinks,
    });
    const email = uniqueEmail('mailfail');
    const res = await auth.handler(
      new Request(`${baseURL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: baseURL,
          [AUTH_CLIENT_IP_HEADER]: nextIp(),
        },
        body: JSON.stringify({ email, password: TEST_PASSWORD, name: 'Mail Fail' }),
      }),
    );
    return { res, email, lines };
  };

  it.each([
    ['MailTemplateError', new MailTemplateError('mail link is not an absolute URL')],
    [
      'MailMessageError',
      new MailMessageError('mail recipient must be exactly one plain email address'),
    ],
  ])('treats a %s as "email not sent" and logs it without the link', async (name, error) => {
    const { res, email, lines } = await signUpWith(async () => {
      throw error;
    });
    expect(res.status).toBe(200);
    expect(await findUserByEmail(h.deps, email)).not.toBeNull();
    const log = await logged(lines, 'auth email not sent');
    expect(log).toContain(`"reason":"${name}"`);
    expect(log).not.toContain('verify-email');
    expect(log).not.toContain(email);
  });

  it('sends no http link in production', async () => {
    const sent: string[] = [];
    const { res, lines } = await signUpWith(async () => void sent.push('sent'), false);
    expect(res.status).toBe(200);
    const log = await logged(lines, '"reason":"InsecureLinkError"');
    expect(sent).toEqual([]);
    expect(log).not.toContain('token=');
  });

  it('sends https links in production', async () => {
    const outbox = createMemoryMailer();
    const { res, email } = await signUpWith(
      (msg) => outbox.send(msg),
      false,
      'https://owlwire.example',
    );
    expect(res.status).toBe(200);
    const link = new URL(extractUrl((await mailTo(outbox.outbox, email)).text));
    expect(link.protocol).toBe('https:');
    expect(link.origin).toBe('https://owlwire.example');
    expect(link.searchParams.get('token')).toBeTruthy();
  });
});

describe('better auth hardening', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ smtp: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it('keeps sessions for 30 days and refreshes them at most once a day', async () => {
    expect(SESSION_EXPIRES_IN_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(SESSION_UPDATE_AGE_SECONDS).toBe(24 * 60 * 60);
    expect(h.deps.auth.options.session).toMatchObject({
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    });
    const u = await h.createUser();
    const result = await h.deps.auth.api.getSession({ headers: new Headers({ cookie: u.cookie }) });
    // Test measurement only: Better Auth stamps expiresAt from its own clock.
    const remainingMs = new Date(result?.session.expiresAt ?? 0).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(SESSION_EXPIRES_IN_SECONDS * 1000 - 60_000);
    expect(remainingMs).toBeLessThanOrEqual(SESSION_EXPIRES_IN_SECONDS * 1000);
  });

  it('configures the rate limits and link lifetimes', () => {
    expect(h.deps.auth.options.rateLimit).toMatchObject({
      enabled: true,
      storage: 'database',
      window: AUTH_RATE_LIMIT.window,
      max: AUTH_RATE_LIMIT.max,
      customRules: { '/sign-in/email': SIGN_IN_RATE_LIMIT },
    });
    expect(h.deps.auth.options.emailAndPassword).toMatchObject({
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
    });
    expect(EMAIL_VERIFICATION_EXPIRES_IN_SECONDS).toBe(3600);
  });

  it('keeps change-email off, since its verification link would sign in without the second factor', async () => {
    expect(h.deps.auth.options.user?.changeEmail?.enabled).toBe(false);
    const u = await h.createUser();
    const res = await h.request('/api/auth/change-email', {
      body: { newEmail: uniqueEmail('changed') },
      cookie: u.cookie,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'CHANGE_EMAIL_DISABLED' });
    const { rows } = await h.harness.ownerPool.query(
      'select 1 from auth_verification where value like $1',
      ['%changed%'],
    );
    expect(rows).toHaveLength(0);
  });

  it('turns telemetry off, hashes verification identifiers and encrypts provider tokens', () => {
    expect(h.deps.auth.options.telemetry).toEqual({ enabled: false });
    expect(h.deps.auth.options.verification).toMatchObject({ storeIdentifier: 'hashed' });
    expect(h.deps.auth.options.account).toMatchObject({ encryptOAuthTokens: true });
  });

  it('derives useSecureCookies from the OWLWIRE_PUBLIC_URL scheme', () => {
    expect(secureCookiesFor('https://owlwire.example')).toBe(true);
    expect(secureCookiesFor('http://localhost:8080')).toBe(false);
    expect(h.deps.auth.options.advanced?.useSecureCookies).toBe(false);
  });

  it('keeps a plain session cookie on http', async () => {
    const email = uniqueEmail('plain');
    expect((await h.signUp(email)).status).toBe(200);
    const cookie = sessionCookie(await h.signInResponse(email));
    expect(cookie.startsWith('owlwire.session_token=')).toBe(true);
    expect(cookie).not.toMatch(/;\s*Secure/i);
  });

  it('issues a __Secure- prefixed Secure session cookie when the public URL is https', async () => {
    const httpsUrl = 'https://owlwire.example';
    const secure = createAuth({
      db: h.deps.authDb,
      env: testAuthEnv({ env: { OWLWIRE_PUBLIC_URL: httpsUrl } }),
      mailer: null,
      logger: h.deps.logger,
      hooks: noopAuthHooks,
      allowHttpLinks: true,
    });
    expect(secure.options.advanced?.useSecureCookies).toBe(true);
    const email = uniqueEmail('secure');
    const post = (path: string, body: unknown) =>
      secure.handler(
        new Request(`${httpsUrl}/api/auth/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: httpsUrl,
            [AUTH_CLIENT_IP_HEADER]: '192.0.2.41',
          },
          body: JSON.stringify(body),
        }),
      );
    expect(
      (await post('sign-up/email', { email, password: TEST_PASSWORD, name: 'Secure' })).status,
    ).toBe(200);
    const res = await post('sign-in/email', { email, password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.startsWith('__Secure-owlwire.session_token=')).toBe(true);
    expect(cookie).toMatch(/;\s*Secure/i);
  });

  it('rate limits sign-in per client IP with database storage shared by every replica', async () => {
    const email = uniqueEmail('ratelimit');
    expect((await h.signUp(email)).status).toBe(200);
    const wrong = { email, password: 'wrong-password-123' };
    const fromIp = (ip: string, headers: Record<string, string> = {}) =>
      h.request('/api/auth/sign-in/email', { body: wrong, remoteAddress: ip, headers });
    for (let i = 0; i < SIGN_IN_RATE_LIMIT.max; i++) {
      expect((await fromIp('203.0.113.7')).status).toBe(401);
    }
    const limited = await fromIp('203.0.113.7');
    expect(limited.status).toBe(429);
    // Problem Details with Retry-After, as on the rest of the API; the library's own header stays for its clients.
    const retryAfter = limited.headers.get('retry-after') ?? '';
    expect(retryAfter).toMatch(/^\d+$/);
    expect(Number(retryAfter)).toBeGreaterThan(0);
    expect(limited.headers.get('x-retry-after')).toBe(retryAfter);
    expect(limited.headers.get('content-type')).toContain('application/problem+json');
    expect(await limited.json()).toMatchObject({ status: 429, code: 'rate_limited' });
    // A client-sent internal header or forwarded header does not move it into another bucket.
    expect((await fromIp('203.0.113.7', { [AUTH_CLIENT_IP_HEADER]: '198.51.100.77' })).status).toBe(
      429,
    );
    expect((await fromIp('203.0.113.7', { 'x-forwarded-for': '198.51.100.78' })).status).toBe(429);
    // Without a socket address (no peer known) a client-sent internal header is dropped, not believed.
    const socketless = await h.app.request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: TEST_BASE_URL,
        [AUTH_CLIENT_IP_HEADER]: '203.0.113.7',
      },
      body: JSON.stringify(wrong),
    });
    expect(socketless.status).toBe(401);
    // A second Auth instance on the same database (another replica) sees the same counter.
    const replica = createAuth({
      db: h.deps.authDb,
      env: h.deps.authEnv,
      mailer: null,
      logger: h.deps.logger,
      hooks: noopAuthHooks,
      allowHttpLinks: true,
    });
    const viaReplica = await replica.handler(
      new Request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: TEST_BASE_URL,
          [AUTH_CLIENT_IP_HEADER]: '203.0.113.7',
        },
        body: JSON.stringify(wrong),
      }),
    );
    expect(viaReplica.status).toBe(429);
    // Another client address has its own bucket.
    expect((await fromIp('198.51.100.9')).status).toBe(401);
  });

  it('answers an unknown email and a wrong password identically', async () => {
    const known = await h.createUser(uniqueEmail('enum'));
    const unknown = await h.signInResponse(uniqueEmail('nobody'), 'some-long-password');
    const wrong = await h.signInResponse(known.email, 'some-long-password');
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(unknown.headers.getSetCookie()).toEqual(wrong.headers.getSetCookie());
  });

  it('refuses a foreign callback URL and logs it through pino with URLs and emails redacted', async () => {
    const { lines, logger } = captureLogger();
    const auth = createAuth({
      db: h.deps.authDb,
      env: h.deps.authEnv,
      mailer: null,
      logger,
      hooks: noopAuthHooks,
      allowHttpLinks: true,
    });
    const email = uniqueEmail('logged');
    const res = await auth.handler(
      new Request(`${TEST_BASE_URL}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: TEST_BASE_URL,
          [AUTH_CLIENT_IP_HEADER]: '192.0.2.42',
        },
        body: JSON.stringify({
          email,
          password: TEST_PASSWORD,
          name: 'Logged',
          callbackURL: `https://attacker.example/steal?token=abc&email=${email}`,
        }),
      }),
    );
    expect(res.status).toBe(403);
    const log = lines.join('\n');
    expect(log).not.toContain(TEST_AUTH_SECRET);
    expect(log).toContain('"component":"auth"');
    expect(log).toContain('[url]');
    expect(log).not.toContain('attacker.example');
    expect(log).not.toContain(email);
  });
});

describe('better auth with smtp, enumeration', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers a sign-up for a taken email like a new one', async () => {
    const taken = await h.createUser(uniqueEmail('taken'));
    const again = await h.signUp(taken.email);
    const fresh = await h.signUp(uniqueEmail('fresh'));
    expect(again.status).toBe(200);
    expect(fresh.status).toBe(200);
    expect(await responseShape(again)).toEqual(await responseShape(fresh));
  });

  it('answers a password reset request for an unknown email like a known one', async () => {
    const known = await h.createUser(uniqueEmail('resetknown'));
    const redirectTo = `${TEST_BASE_URL}/reset-password`;
    const a = await h.request('/api/auth/request-password-reset', {
      body: { email: known.email, redirectTo },
    });
    const b = await h.request('/api/auth/request-password-reset', {
      body: { email: uniqueEmail('resetunknown'), redirectTo },
    });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(await a.json()).toEqual(await b.json());
  });
});

describe('client address behind a trusted proxy', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ smtp: false, trustedProxies: ['192.0.2.1'] });
  });
  afterAll(async () => {
    await h.close();
  });

  it('uses X-Forwarded-For only when the TCP peer is a trusted proxy', async () => {
    const email = uniqueEmail('proxy');
    expect((await h.signUp(email)).status).toBe(200);
    const wrong = { email, password: 'wrong-password-123' };
    const viaProxy = (client: string) =>
      h.request('/api/auth/sign-in/email', {
        body: wrong,
        remoteAddress: '192.0.2.1',
        headers: { 'x-forwarded-for': `${client}, 192.0.2.1` },
      });
    for (let i = 0; i < SIGN_IN_RATE_LIMIT.max; i++) {
      expect((await viaProxy('203.0.113.50')).status).toBe(401);
    }
    expect((await viaProxy('203.0.113.50')).status).toBe(429);
    // Another client behind the same proxy has its own bucket.
    expect((await viaProxy('203.0.113.51')).status).toBe(401);
    // An untrusted peer cannot borrow the limited client's bucket, nor escape its own, with the header.
    const warn = vi.spyOn(h.deps.logger, 'warn');
    const direct = () =>
      h.request('/api/auth/sign-in/email', {
        body: wrong,
        remoteAddress: '198.51.100.20',
        headers: { 'x-forwarded-for': '203.0.113.50' },
      });
    expect((await direct()).status).toBe(401);
    expect((await direct()).status).toBe(401);
    // The operator hears about it once, without the addresses.
    const untrusted = warn.mock.calls.filter((call) =>
      JSON.stringify(call).includes('OWLWIRE_TRUSTED_PROXIES'),
    );
    expect(untrusted).toHaveLength(1);
    expect(JSON.stringify(untrusted)).not.toMatch(/198\.51\.100\.20|203\.0\.113\.50/);
    warn.mockRestore();
  });
});

describe('registration hooks', () => {
  let h: AuthHarness;
  const created: string[] = [];
  beforeAll(async () => {
    h = await createAuthHarness({
      smtp: false,
      hooks: () => ({
        async beforeUserCreate(email) {
          if (email.startsWith('closed-')) throw new RegistrationDeniedError('registration_closed');
        },
        async afterUserCreate(user) {
          created.push(user.email);
        },
      }),
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('answers a refused registration like an accepted one and creates no user', async () => {
    const email = uniqueEmail('closed');
    const res = await h.signUp(email);
    const fresh = await h.signUp(uniqueEmail('open'));
    expect(res.status).toBe(200);
    expect(await responseShape(res)).toEqual(await responseShape(fresh));
    expect(await findUserByEmail(h.deps, email)).toBeNull();
    expect(created).not.toContain(email);
  });

  it('runs the after hook with the lower-cased email of a new user', async () => {
    const email = uniqueEmail('Open');
    expect((await h.signUp(email)).status).toBe(200);
    expect(created).toContain(email.toLowerCase());
  });
});

describe('auth email is sent in the background', () => {
  let h: AuthHarness;
  let release: () => void = () => undefined;
  const pending: MailMessage[] = [];
  const delivered: MailMessage[] = [];
  beforeAll(async () => {
    // A mail server that answers only when the test releases it.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h = await createAuthHarness({
      mailer: {
        async send(msg) {
          pending.push(msg);
          await gate;
          delivered.push(msg);
        },
      },
    });
  });
  afterAll(async () => {
    release();
    await h.close();
  });

  it('answers sign-up and reset requests for known and unknown emails without waiting for the mail server', async () => {
    const fresh = uniqueEmail('slow-new');
    expect((await h.signUp(fresh)).status).toBe(200);
    // The verification mail is in flight, not delivered, yet the response is already here.
    await vi.waitFor(() => expect(pending.map((m) => m.to)).toContain(fresh));
    expect(delivered).toEqual([]);
    expect((await h.signUp(fresh)).status).toBe(200);

    const redirectTo = `${TEST_BASE_URL}/reset-password`;
    const known = await h.request('/api/auth/request-password-reset', {
      body: { email: fresh, redirectTo },
    });
    const unknown = await h.request('/api/auth/request-password-reset', {
      body: { email: uniqueEmail('slow-unknown'), redirectTo },
    });
    expect(known.status).toBe(200);
    expect(await known.json()).toEqual(await unknown.json());
    await vi.waitFor(() => expect(pending.filter((m) => m.to === fresh)).toHaveLength(2));
    expect(delivered).toEqual([]);

    release();
    await vi.waitFor(() => expect(delivered).toHaveLength(2));
  });
});

describe('sessionAuth', () => {
  let h: AuthHarness;
  let mini: Hono<ApiEnv>;
  beforeAll(async () => {
    h = await createAuthHarness({ smtp: false });
    mini = new Hono<ApiEnv>();
    mini.onError((err, c) =>
      err instanceof ProblemError ? problem(c, err) : problem(c, new ProblemError(500, 'internal')),
    );
    mini.get('/whoami', sessionAuth(h.deps.auth), (c) => c.json(c.get('user')));
  });
  afterAll(async () => {
    await h.close();
  });

  const whoami = (cookie?: string) =>
    mini.request(`${TEST_BASE_URL}/whoami`, cookie ? { headers: { cookie } } : {});
  const expectUnauthorized = async (res: Response) => {
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ status: 401, code: 'unauthorized' });
  };
  const sessionToken = (cookie: string) =>
    decodeURIComponent(/owlwire\.session_token=([^;]+)/.exec(cookie)?.[1] ?? '').split('.')[0] ??
    '';

  it('answers 401 problem details without a session and passes the user with one', async () => {
    await expectUnauthorized(await whoami());
    const u = await h.createUser();
    const ok = await whoami(u.cookie);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({
      id: u.id,
      email: u.email,
      isInstanceAdmin: false,
      twoFactorEnabled: false,
    });
    // A fresh session is not refreshed, so no cookie is re-issued.
    expect(ok.headers.getSetCookie()).toEqual([]);
  });

  it('answers 401 for a tampered cookie', async () => {
    const u = await h.createUser();
    const value = /owlwire\.session_token=([^;]+)/.exec(u.cookie)?.[1] ?? '';
    const flipped = `${value.slice(0, 5)}${value[5] === 'a' ? 'b' : 'a'}${value.slice(6)}`;
    await expectUnauthorized(await whoami(`owlwire.session_token=${flipped}`));
  });

  it('answers 401 after sign-out', async () => {
    const u = await h.createUser();
    expect(
      (await h.request('/api/auth/sign-out', { method: 'POST', body: {}, cookie: u.cookie }))
        .status,
    ).toBe(200);
    await expectUnauthorized(await whoami(u.cookie));
  });

  it('answers 401 for an expired session', async () => {
    const u = await h.createUser();
    await h.harness.ownerPool.query(
      "update auth_session set expires_at = now() - interval '1 minute' where token = $1",
      [sessionToken(u.cookie)],
    );
    await expectUnauthorized(await whoami(u.cookie));
  });

  it('forwards the re-issued cookie when the session is extended', async () => {
    const u = await h.createUser();
    // Two days into a 30-day session: due for its daily extension.
    const { rowCount } = await h.harness.ownerPool.query(
      "update auth_session set expires_at = now() + interval '28 days' where token = $1",
      [sessionToken(u.cookie)],
    );
    expect(rowCount).toBe(1);
    const res = await whoami(u.cookie);
    expect(res.status).toBe(200);
    const cookie = sessionCookie(res);
    expect(cookie.startsWith('owlwire.session_token=')).toBe(true);
    expect(cookie).toMatch(new RegExp(`Max-Age=${SESSION_EXPIRES_IN_SECONDS}`));
    const { rows } = await h.harness.ownerPool.query<{ days: number }>(
      'select extract(epoch from expires_at - now()) / 86400 as days from auth_session where token = $1',
      [sessionToken(u.cookie)],
    );
    expect(Number(rows[0]?.days)).toBeGreaterThan(29.9);
  });
});
