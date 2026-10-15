import { randomUUID } from 'node:crypto';
import type { Clock, RegistrationMode } from '@owlwire/core';
import { SYSTEM_ACTOR } from '@owlwire/db';
import type { Logger } from 'pino';
import { type AuthHooks, INVITATION_HEADER } from '../auth/auth.js';
import type { BaseDeps, Deps } from '../deps.js';
import type { createApp } from '../http/app.js';
import { createMemoryMailer, type Mailer, type MemoryMailer } from '../mail/mailer.js';
import { setRegistrationMode } from '../system/registration.js';
import { listWorkspacesForUser } from '../system/user-workspaces.js';
import { markUserEmailVerified } from '../system/users.js';
import { TEST_BASE_URL } from './config.js';
import { createHarness, type Harness } from './harness.js';

export { TEST_BASE_URL };
export const TEST_PASSWORD = 'correct-horse-battery';

export interface HarnessOptions {
  smtp?: boolean;
  mailer?: Mailer;
  env?: Record<string, string>;
  clock?: Clock;
  hooks?: (base: BaseDeps) => AuthHooks;
  /** OWLWIRE_TRUSTED_PROXIES as parsed config (addresses and CIDR ranges). */
  trustedProxies?: string[];
  /** Stored registration mode; defaults to 'open' so tests can sign users up. */
  registration?: RegistrationMode;
  /** Server logger, for tests that inspect what was logged. */
  logger?: Logger;
}
/** @public Request options of AuthHarness.request. */
export interface HarnessRequest {
  method?: string;
  body?: unknown;
  rawBody?: string;
  cookie?: string;
  headers?: Record<string, string>;
  /**
   * TCP peer address of the request. Defaults to a fresh address per request, so the rate limiter does not put
   * unrelated test requests into one bucket.
   */
  remoteAddress?: string;
}
/** @public A signed-in user made by AuthHarness.createUser. */
export interface TestUser {
  id: string;
  email: string;
  name: string;
  cookie: string;
  /** Null when the post sign-up hook did not create one (a test hook that fails or skips it). */
  personalWorkspaceId: string | null;
}
/** @public Options of AuthHarness.signUp. */
export interface SignUpOptions {
  name?: string;
  password?: string;
  /** Sent in the invitation header; invite-mode email sign-up needs it. */
  invitationToken?: string;
}
export interface AuthHarness {
  harness: Harness;
  deps: Deps;
  app: ReturnType<typeof createApp>;
  mailer: MemoryMailer;
  request(path: string, init?: HarnessRequest): Promise<Response>;
  signUp(email: string, opts?: SignUpOptions): Promise<Response>;
  signInResponse(email: string, password?: string): Promise<Response>;
  signIn(email: string, password?: string): Promise<string>;
  createUser(email?: string, opts?: { name?: string; invitationToken?: string }): Promise<TestUser>;
  close(): Promise<void>;
}

export function uniqueEmail(prefix = 'user'): string {
  return `${prefix}-${randomUUID()}@owlwire.test`;
}

export function cookieFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0] ?? '')
    .filter((c) => c.length > 0)
    .join('; ');
}

export function extractUrl(text: string): string {
  const match = text.match(/https?:\/\/\S+/);
  if (!match) throw new Error(`no url found in: ${text}`);
  return match[0];
}

let nextAddress = 0;
/** 10.77.0.1, 10.77.0.2, ...: one TCP peer per request unless the test names one. */
function freshAddress(): string {
  nextAddress = (nextAddress + 1) % 65_024;
  return `10.77.${Math.floor(nextAddress / 254)}.${(nextAddress % 254) + 1}`;
}

export async function createAuthHarness(opts: HarnessOptions = {}): Promise<AuthHarness> {
  const memory = createMemoryMailer();
  const smtp = opts.smtp ?? true;
  const harness = await createHarness({
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.trustedProxies ? { config: { trustedProxies: opts.trustedProxies } } : {}),
    ...(opts.logger ? { logger: opts.logger } : {}),
    auth: {
      smtp,
      ...(opts.env ? { env: opts.env } : {}),
      mailer: smtp ? (opts.mailer ?? memory) : null,
      ...(opts.hooks ? { hooks: opts.hooks } : {}),
    },
  });
  const { deps, app } = harness;
  await setRegistrationMode(deps, opts.registration ?? 'open', SYSTEM_ACTOR);

  const request = async (path: string, init: HarnessRequest = {}): Promise<Response> => {
    const headers: Record<string, string> = { origin: TEST_BASE_URL, ...init.headers };
    if (init.cookie) headers.cookie = init.cookie;
    let body: string | undefined;
    if (init.rawBody !== undefined || init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = init.rawBody ?? JSON.stringify(init.body);
    }
    // @hono/node-server's getConnInfo reads the peer from env.incoming.socket, as in a served request.
    const env = { incoming: { socket: { remoteAddress: init.remoteAddress ?? freshAddress() } } };
    return app.request(
      `${TEST_BASE_URL}${path}`,
      { method: init.method ?? (body ? 'POST' : 'GET'), headers, body },
      env,
    );
  };

  const signUp = (email: string, o: SignUpOptions = {}) =>
    request('/api/auth/sign-up/email', {
      body: { email, password: o.password ?? TEST_PASSWORD, name: o.name ?? 'Test User' },
      ...(o.invitationToken ? { headers: { [INVITATION_HEADER]: o.invitationToken } } : {}),
    });

  const signInResponse = (email: string, password = TEST_PASSWORD) =>
    request('/api/auth/sign-in/email', { body: { email, password } });

  const signIn = async (email: string, password = TEST_PASSWORD): Promise<string> => {
    const res = await signInResponse(email, password);
    if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
    return cookieFrom(res);
  };

  const createUser = async (
    email = uniqueEmail(),
    o: { name?: string; invitationToken?: string } = {},
  ): Promise<TestUser> => {
    const name = o.name ?? 'Test User';
    const res = await signUp(email, {
      name,
      ...(o.invitationToken ? { invitationToken: o.invitationToken } : {}),
    });
    if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { user: { id: string } };
    if (deps.mailer) await markUserEmailVerified(deps, body.user.id);
    const personal = (await listWorkspacesForUser(deps, body.user.id)).find(
      (w) => w.kind === 'personal',
    );
    return {
      id: body.user.id,
      email,
      name,
      cookie: await signIn(email),
      personalWorkspaceId: personal?.id ?? null,
    };
  };

  return {
    harness,
    deps,
    app,
    mailer: memory,
    request,
    signUp,
    signInResponse,
    signIn,
    createUser,
    close: () => harness.close(),
  };
}
