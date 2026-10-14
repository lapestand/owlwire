import { describe, expect, it } from 'vitest';
import { AuthEnvError, loadAuthEnv } from './auth-env.js';

const SECRET = 'a'.repeat(32);

describe('loadAuthEnv', () => {
  it('requires OWLWIRE_AUTH_SECRET', () => {
    expect(() => loadAuthEnv({})).toThrow(AuthEnvError);
    expect(() => loadAuthEnv({})).toThrow(/OWLWIRE_AUTH_SECRET/);
  });

  it('rejects a secret shorter than 32 characters', () => {
    expect(() => loadAuthEnv({ OWLWIRE_AUTH_SECRET: 'short' })).toThrow(/at least 32/);
  });

  it('derives baseURL from OWLWIRE_PUBLIC_URL without trailing slash', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_PUBLIC_URL: 'https://owl.example.com/',
    });
    expect(env.baseURL).toBe('https://owl.example.com');
    expect(env.publicUrlConfigured).toBe(true);
  });

  it('falls back to localhost and the configured port', () => {
    const env = loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET, OWLWIRE_PORT: '9090' });
    expect(env.baseURL).toBe('http://localhost:9090');
    expect(env.publicUrlConfigured).toBe(false);
  });

  it('returns smtp null when OWLWIRE_SMTP_URL is missing or empty', () => {
    expect(loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET }).smtp).toBeNull();
    expect(
      loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET, OWLWIRE_SMTP_URL: '', OWLWIRE_SMTP_FROM: '' })
        .smtp,
    ).toBeNull();
  });

  it('requires OWLWIRE_SMTP_FROM when OWLWIRE_SMTP_URL is set', () => {
    expect(() =>
      loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET, OWLWIRE_SMTP_URL: 'smtp://u:p@mail:587' }),
    ).toThrow(/OWLWIRE_SMTP_FROM/);
  });

  it('rejects a non-smtp url', () => {
    expect(() =>
      loadAuthEnv({
        OWLWIRE_AUTH_SECRET: SECRET,
        OWLWIRE_SMTP_URL: 'http://mail',
        OWLWIRE_SMTP_FROM: 'a@b.c',
      }),
    ).toThrow(/smtp:\/\//);
  });

  it('parses smtp settings', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_SMTP_URL: 'smtps://u:p@mail:465',
      OWLWIRE_SMTP_FROM: 'Owlwire <no-reply@example.com>',
    });
    expect(env.smtp).toEqual({
      url: 'smtps://u:p@mail:465',
      from: 'Owlwire <no-reply@example.com>',
    });
  });

  it('enables a social provider only when id and secret are both set', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_GITHUB_CLIENT_ID: 'gh',
      OWLWIRE_GITHUB_CLIENT_SECRET: 'ghs',
    });
    expect(env.social.github).toEqual({ clientId: 'gh', clientSecret: 'ghs' });
    expect(env.social.google).toBeNull();
    expect(env.social.discord).toBeNull();
  });

  it('rejects a half-configured social provider', () => {
    expect(() =>
      loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET, OWLWIRE_GOOGLE_CLIENT_ID: 'g' }),
    ).toThrow(/OWLWIRE_GOOGLE_CLIENT_ID and OWLWIRE_GOOGLE_CLIENT_SECRET/);
  });

  it('reuses the discord bot application credentials for discord login', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_DISCORD_CLIENT_ID: 'd',
      OWLWIRE_DISCORD_CLIENT_SECRET: 'ds',
    });
    expect(env.social.discord).toEqual({ clientId: 'd', clientSecret: 'ds' });
  });

  it('never echoes secret values in error messages', () => {
    const leaked = 'super-secret-value';
    for (const source of [
      { OWLWIRE_AUTH_SECRET: leaked },
      { OWLWIRE_AUTH_SECRET: SECRET, OWLWIRE_GOOGLE_CLIENT_SECRET: leaked },
      {
        OWLWIRE_AUTH_SECRET: SECRET,
        OWLWIRE_SMTP_URL: `http://u:${leaked}@mail`,
        OWLWIRE_SMTP_FROM: 'a@b.c',
      },
    ]) {
      try {
        loadAuthEnv(source);
        expect.unreachable();
      } catch (err) {
        expect(err).toBeInstanceOf(AuthEnvError);
        expect((err as Error).message).not.toContain(leaked);
      }
    }
  });
});
