import { SYSTEM_ACTOR } from '@owlwire/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type AuthHarness,
  createAuthHarness,
  TEST_PASSWORD,
  uniqueEmail,
} from '../test/auth-harness.js';
import { testAuthEnv } from '../test/config.js';
import { collectAuthStartupWarnings } from './auth-warnings.js';
import { AdminInputError, bootstrapInstanceAdmin } from './instance-admin.js';
import { setRegistrationMode } from './registration.js';
import { listWorkspacesForUser } from './user-workspaces.js';
import { findUserByEmail } from './users.js';

const has = (warnings: string[], text: string) => warnings.some((w) => w.includes(text));

describe('instance admin bootstrap', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ registration: 'closed' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('creates a verified admin with a generated password in closed mode', async () => {
    const email = uniqueEmail('Root');
    const result = await bootstrapInstanceAdmin(h.deps, { email });
    expect(result).toMatchObject({ created: true, passwordIgnored: false });
    expect(result.generatedPassword?.length).toBeGreaterThanOrEqual(20);
    const user = await findUserByEmail(h.deps, email);
    expect(user).toMatchObject({
      isInstanceAdmin: true,
      emailVerified: true,
      email: email.toLowerCase(),
    });
    expect(user?.name).toBe(email.toLowerCase().split('@')[0]);
    expect(await listWorkspacesForUser(h.deps, result.userId)).toHaveLength(1);
    expect(
      (await h.signInResponse(email.toLowerCase(), result.generatedPassword ?? '')).status,
    ).toBe(200);
    expect(h.mailer.outbox.some((m) => m.to === email.toLowerCase())).toBe(false);
    const warnings = await collectAuthStartupWarnings(h.deps, {});
    expect(has(warnings, 'owlwire admin create')).toBe(false);
  });

  it('uses a provided password and refuses a short one', async () => {
    const email = uniqueEmail('pw');
    const r = await bootstrapInstanceAdmin(h.deps, { email, name: 'Pw', password: TEST_PASSWORD });
    expect(r.generatedPassword).toBeNull();
    expect((await findUserByEmail(h.deps, email))?.name).toBe('Pw');
    expect((await h.signInResponse(email.toLowerCase())).status).toBe(200);
    const short = uniqueEmail('short');
    await expect(
      bootstrapInstanceAdmin(h.deps, { email: short, password: 'short' }),
    ).rejects.toBeInstanceOf(AdminInputError);
    expect(await findUserByEmail(h.deps, short)).toBeNull();
  });

  it('promotes an existing user and ignores a provided password', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const u = await h.createUser();
    await setRegistrationMode(h.deps, 'closed', SYSTEM_ACTOR);
    const r = await bootstrapInstanceAdmin(h.deps, {
      email: u.email.toUpperCase(),
      password: 'another-long-password',
    });
    expect(r).toEqual({
      userId: u.id,
      created: false,
      generatedPassword: null,
      passwordIgnored: true,
    });
    expect((await findUserByEmail(h.deps, u.email))?.isInstanceAdmin).toBe(true);
    expect((await h.signInResponse(u.email)).status).toBe(200);
    // Running it again for an admin is a harmless no-op.
    expect(await bootstrapInstanceAdmin(h.deps, { email: u.email })).toEqual({
      userId: u.id,
      created: false,
      generatedPassword: null,
      passwordIgnored: false,
    });
  });

  it('refuses an invalid email', async () => {
    await expect(bootstrapInstanceAdmin(h.deps, { email: 'nope' })).rejects.toThrow(
      /invalid email/,
    );
  });
});

describe('startup warnings: no instance admin', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ registration: 'closed' });
  });
  afterAll(async () => {
    await h.close();
  });

  it('tells the operator to run admin create while registration is closed', async () => {
    const warnings = await collectAuthStartupWarnings(h.deps, {});
    expect(has(warnings, 'registration is closed')).toBe(true);
    expect(has(warnings, 'owlwire admin create')).toBe(true);
    expect(has(warnings, 'SMTP is not configured')).toBe(false);
  });
});

describe('startup warnings without smtp', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({
      smtp: false,
      env: {
        OWLWIRE_DISCORD_CLIENT_ID: 'd',
        OWLWIRE_DISCORD_CLIENT_SECRET: 'discord-client-secret-value',
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('reports the email-less personal mode', async () => {
    const warnings = await collectAuthStartupWarnings(h.deps, {});
    expect(has(warnings, 'SMTP is not configured')).toBe(true);
    // The harness sets OWLWIRE_PUBLIC_URL, so the social callback warning stays quiet.
    expect(has(warnings, 'OWLWIRE_PUBLIC_URL is not set')).toBe(false);
  });

  it('warns about social sign-in without a public URL', async () => {
    const authEnv = { ...h.deps.authEnv, publicUrlConfigured: false };
    const warnings = await collectAuthStartupWarnings({ ...h.deps, authEnv }, {});
    expect(has(warnings, 'OWLWIRE_PUBLIC_URL is not set')).toBe(true);
  });

  it('warns about an http public URL only in production', async () => {
    expect(has(await collectAuthStartupWarnings(h.deps, {}), 'is not https')).toBe(false);
    const prod = await collectAuthStartupWarnings(h.deps, { NODE_ENV: 'production' });
    expect(has(prod, 'is not https')).toBe(true);
  });

  it('warns about an https public URL without trusted proxies', async () => {
    const https = testAuthEnv({ env: { OWLWIRE_PUBLIC_URL: 'https://owlwire.example' } });
    const bare = await collectAuthStartupWarnings({ ...h.deps, authEnv: https }, {});
    expect(has(bare, 'OWLWIRE_TRUSTED_PROXIES is empty')).toBe(true);
    expect(has(bare, 'is not https')).toBe(false);
    const listed = await collectAuthStartupWarnings(
      { ...h.deps, authEnv: https, config: { ...h.deps.config, trustedProxies: ['10.0.0.0/8'] } },
      {},
    );
    expect(has(listed, 'OWLWIRE_TRUSTED_PROXIES')).toBe(false);
  });

  it('never prints secrets', async () => {
    const warnings = await collectAuthStartupWarnings(
      { ...h.deps, authEnv: { ...h.deps.authEnv, publicUrlConfigured: false } },
      { NODE_ENV: 'production' },
    );
    const text = warnings.join('\n');
    expect(text).not.toContain(h.deps.authEnv.secret);
    expect(text).not.toContain('discord-client-secret-value');
  });
});
