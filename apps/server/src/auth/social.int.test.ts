import { randomInt } from 'node:crypto';
import { SYSTEM_ACTOR } from '@owlwire/db';
import { seedCommunityWorkspace, seedInvitation } from '@owlwire/db/fixtures';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { setRegistrationMode } from '../system/registration.js';
import { listWorkspacesForUser } from '../system/user-workspaces.js';
import { findUserByEmail } from '../system/users.js';
import {
  type AuthHarness,
  cookieFrom,
  createAuthHarness,
  TEST_BASE_URL,
  TEST_PASSWORD,
  uniqueEmail,
} from '../test/auth-harness.js';
import { totp } from '../test/totp.js';
import { INVITATION_TTL_MS, newInvitationToken } from '../workspaces/invitation-token.js';
import { TWO_FACTOR_CHALLENGE_PATH } from './second-factor-gate.js';

// No request leaves the process: the provider token and profile endpoints are answered by a fetch stub, and any
// other outgoing request fails the test.

function refuseOutgoing(url: string): never {
  throw new Error(`unexpected outgoing request: ${url}`);
}

interface GitHubIdentity {
  email: string;
  /** What GitHub reports for the address in /user/emails. */
  verified?: boolean;
  /** GitHub account id; unique per test so an account row from another test is never reused. */
  id?: number;
}

function mockGitHub(identity: GitHubIdentity): number {
  const id = identity.id ?? randomInt(1, 2 ** 31);
  const { email } = identity;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return Response.json({
        access_token: 'fake-github-access-token',
        token_type: 'bearer',
        scope: 'read:user,user:email',
      });
    }
    if (url === 'https://api.github.com/user') {
      return Response.json({ id, login: 'octo', name: 'Octo Cat', email, avatar_url: null });
    }
    if (url === 'https://api.github.com/user/emails') {
      return Response.json([
        { email, primary: true, verified: identity.verified ?? true, visibility: 'public' },
      ]);
    }
    return refuseOutgoing(url);
  });
  return id;
}

interface DiscordIdentity {
  email: string;
  /** Discord's `verified` flag on the account's address. */
  verified: boolean;
}

function mockDiscord(identity: DiscordIdentity): string {
  const id = String(randomInt(1, 2 ** 47));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://discord.com/api/oauth2/token') {
      return Response.json({
        access_token: 'fake-discord-access-token',
        token_type: 'Bearer',
        expires_in: 604800,
        scope: 'identify email',
      });
    }
    // better-fetch percent-encodes the @ of the path.
    if (decodeURIComponent(url) === 'https://discord.com/api/users/@me') {
      return Response.json({
        id,
        username: 'wumpus',
        global_name: 'Wumpus',
        discriminator: '0',
        avatar: null,
        email: identity.email,
        verified: identity.verified,
      });
    }
    return refuseOutgoing(url);
  });
  return id;
}

/** An unsigned JWT: the code flow reads the id token Google's token endpoint returns over TLS without verifying it. */
function fakeJwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'RS256', typ: 'JWT', kid: 'test' })}.${part(claims)}.c2lnbmF0dXJl`;
}

function mockGoogle(identity: { email: string }): string {
  const sub = String(randomInt(1, 2 ** 47));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === 'https://oauth2.googleapis.com/token') {
      const now = Math.floor(Date.now() / 1000);
      return Response.json({
        access_token: 'fake-google-access-token',
        token_type: 'Bearer',
        expires_in: 3599,
        scope: 'openid email profile',
        id_token: fakeJwt({
          iss: 'https://accounts.google.com',
          aud: 'google-id',
          sub,
          email: identity.email,
          email_verified: true,
          name: 'Goo Gle',
          iat: now,
          exp: now + 3600,
        }),
      });
    }
    return refuseOutgoing(url);
  });
  return sub;
}

type Provider = 'github' | 'discord' | 'google';

/** Follows the provider redirect back to our callback, as the browser would after the user approves. */
async function completeAtCallback(
  h: AuthHarness,
  start: Response,
  cookie: string,
  provider: Provider = 'github',
): Promise<Response> {
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get('state') ?? '';
  return h.request(
    `/api/auth/callback/${provider}?code=test-code&state=${encodeURIComponent(state)}`,
    { cookie },
  );
}

async function socialRoundTrip(h: AuthHarness, provider: Provider): Promise<Response> {
  const start = await h.request('/api/auth/sign-in/social', {
    body: { provider, callbackURL: '/' },
  });
  return completeAtCallback(h, start.clone(), cookieFrom(start), provider);
}

const githubRoundTrip = (h: AuthHarness): Promise<Response> => socialRoundTrip(h, 'github');

function hasSessionCookie(res: Response): boolean {
  return res.headers.getSetCookie().some((c) => /session_token=[^;]+/.test(c));
}

function errorOf(res: Response): string | null {
  return new URL(res.headers.get('location') ?? '/', TEST_BASE_URL).searchParams.get('error');
}

describe('social sign-in', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({
      env: {
        OWLWIRE_GITHUB_CLIENT_ID: 'gh-id',
        OWLWIRE_GITHUB_CLIENT_SECRET: 'gh-secret',
        OWLWIRE_GOOGLE_CLIENT_ID: 'google-id',
        OWLWIRE_GOOGLE_CLIENT_SECRET: 'google-secret',
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await h.close();
  });

  const workspaceCount = async (): Promise<number> => {
    const { rows } = await h.harness.ownerPool.query<{ n: number }>(
      'select count(*)::int as n from workspaces',
    );
    return rows[0]?.n ?? -1;
  };

  const sessionUserId = async (cookie: string): Promise<string | null> => {
    const res = await h.request('/api/auth/get-session', { cookie });
    const body = (await res.json()) as { user?: { id: string } } | null;
    return body?.user?.id ?? null;
  };

  const githubAccountsOf = async (userId: string): Promise<number> => {
    const { rows } = await h.harness.ownerPool.query<{ n: number }>(
      "select count(*)::int as n from auth_account where user_id = $1 and provider_id = 'github'",
      [userId],
    );
    return rows[0]?.n ?? -1;
  };

  it('redirects to GitHub with our callback url', async () => {
    const res = await h.request('/api/auth/sign-in/social', {
      body: { provider: 'github', callbackURL: '/' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string };
    const url = new URL(body.url);
    expect(url.host).toBe('github.com');
    expect(url.searchParams.get('client_id')).toBe('gh-id');
    expect(url.searchParams.get('redirect_uri')).toBe(`${TEST_BASE_URL}/api/auth/callback/github`);
  });

  it('refuses an unconfigured provider', async () => {
    const res = await h.request('/api/auth/sign-in/social', {
      body: { provider: 'discord', callbackURL: '/' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('creates the user and the personal workspace in open mode', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const email = uniqueEmail('octo-open');
    const githubId = mockGitHub({ email });
    const res = await githubRoundTrip(h);
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBeNull();
    expect(hasSessionCookie(res)).toBe(true);
    const user = await findUserByEmail(h.deps, email);
    expect(user).not.toBeNull();
    expect(user?.emailVerified).toBe(true);
    expect(await listWorkspacesForUser(h.deps, user?.id ?? '')).toHaveLength(1);
    // The provider token reaches auth_account only encrypted.
    const { rows } = await h.harness.ownerPool.query<{ account_id: string; access_token: string }>(
      "select account_id, access_token from auth_account where user_id = $1 and provider_id = 'github'",
      [user?.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.account_id).toBe(String(githubId));
    expect(rows[0]?.access_token).not.toContain('fake-github-access-token');
  });

  it('signs a returning user in with the same GitHub account', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const email = uniqueEmail('octo-return');
    const id = mockGitHub({ email });
    expect(errorOf(await githubRoundTrip(h))).toBeNull();
    // Registration closes; an existing account still signs in.
    await setRegistrationMode(h.deps, 'closed', SYSTEM_ACTOR);
    vi.restoreAllMocks();
    mockGitHub({ email, id });
    const again = await githubRoundTrip(h);
    expect(again.status).toBe(302);
    expect(errorOf(again)).toBeNull();
    expect(hasSessionCookie(again)).toBe(true);
  });

  it('does not create a user through social sign-in when registration is closed', async () => {
    await setRegistrationMode(h.deps, 'closed', SYSTEM_ACTOR);
    const before = await workspaceCount();
    const email = uniqueEmail('octo-closed');
    mockGitHub({ email });
    const res = await githubRoundTrip(h);
    expect(res.status).toBe(302);
    expect(res.headers.get('location') ?? '').toContain('error');
    expect(hasSessionCookie(res)).toBe(false);
    expect(await findUserByEmail(h.deps, email)).toBeNull();
    expect(await workspaceCount()).toBe(before);
  });

  it('does not create a user through social sign-in in invite mode without an invitation', async () => {
    await setRegistrationMode(h.deps, 'invite', SYSTEM_ACTOR);
    const before = await workspaceCount();
    const email = uniqueEmail('octo-uninvited');
    mockGitHub({ email });
    const res = await githubRoundTrip(h);
    expect(res.status).toBe(302);
    expect(errorOf(res)).not.toBeNull();
    expect(hasSessionCookie(res)).toBe(false);
    expect(await findUserByEmail(h.deps, email)).toBeNull();
    expect(await workspaceCount()).toBe(before);
  });

  it('admits an invited address through social sign-in in invite mode', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const owner = await h.createUser();
    const workspaceId = await seedCommunityWorkspace(h.deps.db, owner.id);
    const email = uniqueEmail('octo-invited');
    await seedInvitation(h.deps.db, {
      workspaceId,
      email,
      invitedBy: owner.id,
      tokenHash: newInvitationToken().tokenHash,
      expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
    });
    await setRegistrationMode(h.deps, 'invite', SYSTEM_ACTOR);
    mockGitHub({ email });
    const res = await githubRoundTrip(h);
    expect(errorOf(res)).toBeNull();
    const user = await findUserByEmail(h.deps, email);
    expect(user).not.toBeNull();
    expect(await listWorkspacesForUser(h.deps, user?.id ?? '')).toHaveLength(1);
  });

  it('does not create a user from an address the provider has not verified', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const before = await workspaceCount();
    const email = uniqueEmail('octo-unverified');
    mockGitHub({ email, verified: false });
    const res = await githubRoundTrip(h);
    expect(res.status).toBe(302);
    // The same code as for an existing account (next block), so the answer does not tell whether one exists.
    expect(errorOf(res)).toBe('account_not_linked');
    expect(hasSessionCookie(res)).toBe(false);
    expect(await findUserByEmail(h.deps, email)).toBeNull();
    expect(await workspaceCount()).toBe(before);
  });

  describe('account linking', () => {
    it('does not link an unverified provider address to an existing account', async () => {
      await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
      // The victim has a verified local account; the attacker's GitHub account claims the same address.
      const victim = await h.createUser(uniqueEmail('victim'));
      expect((await findUserByEmail(h.deps, victim.email))?.emailVerified).toBe(true);
      mockGitHub({ email: victim.email, verified: false });
      const res = await githubRoundTrip(h);
      expect(res.status).toBe(302);
      expect(errorOf(res)).toBe('account_not_linked');
      expect(hasSessionCookie(res)).toBe(false);
      expect(await githubAccountsOf(victim.id)).toBe(0);
    });

    it('answers an unverified provider address the same whether or not an account has it', async () => {
      // Anyone can put an arbitrary unverified address on some provider accounts; the callback must not reveal
      // through its error code or description whether an Owlwire account exists for that address.
      await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
      const existing = await h.createUser(uniqueEmail('probe-existing'));
      mockGitHub({ email: existing.email, verified: false });
      const forExisting = await githubRoundTrip(h);
      vi.restoreAllMocks();
      mockGitHub({ email: uniqueEmail('probe-absent'), verified: false });
      const forAbsent = await githubRoundTrip(h);

      for (const res of [forExisting, forAbsent]) {
        expect(res.status).toBe(302);
        expect(hasSessionCookie(res)).toBe(false);
      }
      const location = (res: Response) => new URL(res.headers.get('location') ?? '', TEST_BASE_URL);
      expect(location(forExisting).href).toBe(location(forAbsent).href);
      expect([...location(forAbsent).searchParams.keys()]).toEqual(['error']);
      expect(errorOf(forAbsent)).toBe('account_not_linked');
    });

    it('collapses the code on the error page the client asked for, keeping that page', async () => {
      await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
      mockGitHub({ email: uniqueEmail('probe-page'), verified: false });
      const start = await h.request('/api/auth/sign-in/social', {
        body: { provider: 'github', callbackURL: '/', errorCallbackURL: '/sign-in?from=github' },
      });
      const res = await completeAtCallback(h, start.clone(), cookieFrom(start));
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') ?? '', TEST_BASE_URL);
      expect(location.origin).toBe(TEST_BASE_URL);
      expect(location.pathname).toBe('/sign-in');
      expect(Object.fromEntries(location.searchParams)).toEqual({
        from: 'github',
        error: 'account_not_linked',
      });
    });

    it('does not link a verified provider address to an unverified local account', async () => {
      // Without SMTP local addresses are never verified, so an account squatted at someone else's address
      // cannot capture that person's GitHub identity on their first social sign-in.
      const plain = await createAuthHarness({
        smtp: false,
        env: { OWLWIRE_GITHUB_CLIENT_ID: 'gh-id', OWLWIRE_GITHUB_CLIENT_SECRET: 'gh-secret' },
      });
      try {
        const local = await plain.createUser(uniqueEmail('squatter'));
        expect((await findUserByEmail(plain.deps, local.email))?.emailVerified).toBe(false);
        mockGitHub({ email: local.email, verified: true });
        const res = await githubRoundTrip(plain);
        expect(res.status).toBe(302);
        expect(errorOf(res)).not.toBeNull();
        expect(hasSessionCookie(res)).toBe(false);
        const { rows } = await plain.harness.ownerPool.query<{ n: number }>(
          "select count(*)::int as n from auth_account where user_id = $1 and provider_id = 'github'",
          [local.id],
        );
        expect(rows[0]?.n).toBe(0);
      } finally {
        await plain.close();
      }
    });

    it('does not link a provider address verified on both sides without the user signed in', async () => {
      // Whoever controls the mailbox could otherwise add a provider account at the address and get a permanent way
      // in that skips the password and the second factor.
      await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
      const local = await h.createUser(uniqueEmail('linked'));
      expect((await findUserByEmail(h.deps, local.email))?.emailVerified).toBe(true);
      const before = await workspaceCount();
      mockGitHub({ email: local.email, verified: true });
      const res = await githubRoundTrip(h);
      expect(res.status).toBe(302);
      expect(errorOf(res)).toBe('account_not_linked');
      expect(hasSessionCookie(res)).toBe(false);
      expect(await githubAccountsOf(local.id)).toBe(0);
      expect(await workspaceCount()).toBe(before);
    });

    it('refuses an explicit link of an unverified provider address while signed in', async () => {
      await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
      const local = await h.createUser(uniqueEmail('explicit'));
      mockGitHub({ email: local.email, verified: false });
      const start = await h.request('/api/auth/link-social', {
        body: { provider: 'github', callbackURL: '/' },
        cookie: local.cookie,
      });
      const res = await completeAtCallback(
        h,
        start.clone(),
        [local.cookie, cookieFrom(start)].filter(Boolean).join('; '),
      );
      expect(res.status).toBe(302);
      expect(errorOf(res)).not.toBeNull();
      expect(await githubAccountsOf(local.id)).toBe(0);
    });

    it('links a verified provider address explicitly while signed in', async () => {
      await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
      const local = await h.createUser(uniqueEmail('explicit-ok'));
      const githubId = mockGitHub({ email: local.email, verified: true });
      const start = await h.request('/api/auth/link-social', {
        body: { provider: 'github', callbackURL: '/' },
        cookie: local.cookie,
      });
      const res = await completeAtCallback(
        h,
        start.clone(),
        [local.cookie, cookieFrom(start)].filter(Boolean).join('; '),
      );
      expect(res.status).toBe(302);
      expect(errorOf(res)).toBeNull();
      expect(await githubAccountsOf(local.id)).toBe(1);

      // The linked provider now signs this user in (no second factor is enabled).
      vi.restoreAllMocks();
      mockGitHub({ email: local.email, verified: true, id: githubId });
      const again = await githubRoundTrip(h);
      expect(errorOf(again)).toBeNull();
      expect(hasSessionCookie(again)).toBe(true);
      expect(await sessionUserId(cookieFrom(again))).toBe(local.id);
    });
  });

  describe('second factor', () => {
    /** Links GitHub while signed in, then turns TOTP on; returns the GitHub id and the TOTP secret. */
    const linkedTotpUser = async () => {
      await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
      const u = await h.createUser(uniqueEmail('totp'));
      const githubId = mockGitHub({ email: u.email, verified: true });
      const start = await h.request('/api/auth/link-social', {
        body: { provider: 'github', callbackURL: '/' },
        cookie: u.cookie,
      });
      const linked = await completeAtCallback(
        h,
        start.clone(),
        [u.cookie, cookieFrom(start)].join('; '),
      );
      expect(errorOf(linked)).toBeNull();
      vi.restoreAllMocks();
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
      return { u, githubId, secret, backupCodes };
    };

    const sessionCount = async (userId: string): Promise<number> => {
      const { rows } = await h.harness.ownerPool.query<{ n: number }>(
        'select count(*)::int as n from auth_session where user_id = $1',
        [userId],
      );
      return rows[0]?.n ?? -1;
    };

    it('asks a TOTP user for the code after GitHub sign-in and signs in only with it', async () => {
      const { u, githubId, secret } = await linkedTotpUser();
      const sessionsBefore = await sessionCount(u.id);
      mockGitHub({ email: u.email, verified: true, id: githubId });
      const res = await githubRoundTrip(h);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.get('location') ?? '', TEST_BASE_URL);
      expect(location.origin).toBe(TEST_BASE_URL);
      expect(location.pathname).toBe(TWO_FACTOR_CHALLENGE_PATH);
      expect(location.searchParams.get('callbackURL')).toBe(`${TEST_BASE_URL}/`);
      expect(hasSessionCookie(res)).toBe(false);
      // The session the provider sign-in created is revoked, not just hidden.
      expect(await sessionCount(u.id)).toBe(sessionsBefore);
      const challenge = cookieFrom(res);
      expect(await sessionUserId(challenge)).toBeNull();

      const wrong = await h.request('/api/auth/two-factor/verify-totp', {
        body: { code: totp(secret, new Date()) === '000000' ? '111111' : '000000' },
        cookie: challenge,
      });
      expect(wrong.status).toBe(401);
      const ok = await h.request('/api/auth/two-factor/verify-totp', {
        body: { code: totp(secret, new Date()) },
        cookie: challenge,
      });
      expect(ok.status).toBe(200);
      expect(await sessionUserId(cookieFrom(ok))).toBe(u.id);
    });

    it('completes a GitHub sign-in with a backup code', async () => {
      const { u, githubId, backupCodes } = await linkedTotpUser();
      mockGitHub({ email: u.email, verified: true, id: githubId });
      const res = await githubRoundTrip(h);
      expect(hasSessionCookie(res)).toBe(false);
      const ok = await h.request('/api/auth/two-factor/verify-backup-code', {
        body: { code: backupCodes[0] },
        cookie: cookieFrom(res),
      });
      expect(ok.status).toBe(200);
      expect(await sessionUserId(cookieFrom(ok))).toBe(u.id);
    });
  });

  it('signs a user in through the Google redirect flow', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const email = uniqueEmail('google');
    const sub = mockGoogle({ email });
    const start = await h.request('/api/auth/sign-in/social', {
      body: { provider: 'google', callbackURL: '/' },
    });
    expect(start.status).toBe(200);
    const authorize = new URL(((await start.clone().json()) as { url: string }).url);
    expect(authorize.origin).toBe('https://accounts.google.com');
    expect(authorize.searchParams.get('client_id')).toBe('google-id');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${TEST_BASE_URL}/api/auth/callback/google`,
    );
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('code_challenge')).toBeTruthy();

    const res = await completeAtCallback(h, start, cookieFrom(start), 'google');
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBeNull();
    expect(hasSessionCookie(res)).toBe(true);
    const user = await findUserByEmail(h.deps, email);
    expect(user?.emailVerified).toBe(true);
    expect(await sessionUserId(cookieFrom(res))).toBe(user?.id);
    const { rows } = await h.harness.ownerPool.query<{ account_id: string }>(
      "select account_id from auth_account where user_id = $1 and provider_id = 'google'",
      [user?.id],
    );
    expect(rows.map((r) => r.account_id)).toEqual([sub]);
  });

  it('refuses a callback whose state arrives without the state cookie', async () => {
    // Login CSRF: someone who starts a sign-in with their own provider account and hands the callback link to a
    // victim must not get the victim's browser signed in as them.
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const email = uniqueEmail('csrf');
    mockGitHub({ email });
    const start = await h.request('/api/auth/sign-in/social', {
      body: { provider: 'github', callbackURL: '/' },
    });
    const res = await completeAtCallback(h, start.clone(), '');
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBe('state_mismatch');
    expect(hasSessionCookie(res)).toBe(false);
    expect(await findUserByEmail(h.deps, email)).toBeNull();
    const providerCalls = vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => {
      const { hostname } = new URL(input instanceof Request ? input.url : input);
      return hostname === 'github.com' || hostname === 'api.github.com';
    });
    expect(providerCalls).toHaveLength(0);

    // The browser that started the sign-in can still finish it.
    const own = await completeAtCallback(h, start, cookieFrom(start));
    expect(errorOf(own)).toBeNull();
    expect(hasSessionCookie(own)).toBe(true);
  });

  it.each([
    ['callbackURL', { callbackURL: 'https://evil.example/' }],
    ['errorCallbackURL', { callbackURL: '/', errorCallbackURL: 'https://evil.example/error' }],
    ['newUserCallbackURL', { callbackURL: '/', newUserCallbackURL: 'https://evil.example/new' }],
  ])('refuses an off-origin %s', async (_name, urls) => {
    const before = await h.harness.ownerPool.query<{ n: number }>(
      'select count(*)::int as n from auth_verification',
    );
    const res = await h.request('/api/auth/sign-in/social', {
      body: { provider: 'github', ...urls },
    });
    expect(res.status).toBe(403);
    expect(hasSessionCookie(res)).toBe(false);
    expect(res.headers.getSetCookie().some((c) => /state=[^;]+/.test(c))).toBe(false);
    const after = await h.harness.ownerPool.query<{ n: number }>(
      'select count(*)::int as n from auth_verification',
    );
    expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
  });

  it('refuses Google id-token sign-in', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const res = await h.request('/api/auth/sign-in/social', {
      body: { provider: 'google', idToken: { token: 'not-a-real-id-token' } },
    });
    // Refused before the token is looked at (a bad token alone would answer 401 INVALID_TOKEN).
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'ID_TOKEN_NOT_SUPPORTED' });
    expect(hasSessionCookie(res)).toBe(false);
  });
});

describe('Discord sign-in', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({
      env: {
        OWLWIRE_DISCORD_CLIENT_ID: 'discord-id',
        OWLWIRE_DISCORD_CLIENT_SECRET: 'discord-secret',
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await h.close();
  });

  it('creates the user from an address Discord has verified', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const email = uniqueEmail('discord');
    const id = mockDiscord({ email, verified: true });
    const start = await h.request('/api/auth/sign-in/social', {
      body: { provider: 'discord', callbackURL: '/' },
    });
    const authorize = new URL(((await start.clone().json()) as { url: string }).url);
    expect(authorize.origin).toBe('https://discord.com');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      `${TEST_BASE_URL}/api/auth/callback/discord`,
    );
    const res = await completeAtCallback(h, start, cookieFrom(start), 'discord');
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBeNull();
    expect(hasSessionCookie(res)).toBe(true);
    const user = await findUserByEmail(h.deps, email);
    expect(user?.emailVerified).toBe(true);
    expect(await listWorkspacesForUser(h.deps, user?.id ?? '')).toHaveLength(1);
    const { rows } = await h.harness.ownerPool.query<{ account_id: string }>(
      "select account_id from auth_account where user_id = $1 and provider_id = 'discord'",
      [user?.id],
    );
    expect(rows.map((r) => r.account_id)).toEqual([id]);
  });

  it('does not create a user from an address Discord has not verified', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const email = uniqueEmail('discord-unverified');
    mockDiscord({ email, verified: false });
    const res = await socialRoundTrip(h, 'discord');
    expect(res.status).toBe(302);
    expect(errorOf(res)).toBe('account_not_linked');
    expect(hasSessionCookie(res)).toBe(false);
    expect(await findUserByEmail(h.deps, email)).toBeNull();
  });
});
