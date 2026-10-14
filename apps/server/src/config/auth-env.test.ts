import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { AuthEnvError, loadAuthEnv } from './auth-env.js';

const SECRET = 'fixture-secret-for-auth-env-tests-0123';

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
      let error: unknown;
      try {
        loadAuthEnv(source);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(AuthEnvError);
      expect((error as Error).message).not.toContain(leaked);
    }
  });

  it.each([
    'ftp://owl.example.com',
    'javascript:alert(1)',
    'htps://owl.example.com',
    'https://owl.example.com/app',
    'https://owl.example.com/?a=1',
    'https://owl.example.com/#top',
    'https://user:pw@owl.example.com',
    'not a url',
  ])('rejects OWLWIRE_PUBLIC_URL %s', (url) => {
    expect(() => loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET, OWLWIRE_PUBLIC_URL: url })).toThrow(
      /OWLWIRE_PUBLIC_URL/,
    );
  });

  it('accepts http and https origins with a port', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_PUBLIC_URL: 'http://localhost:3000',
    });
    expect(env.baseURL).toBe('http://localhost:3000');
  });

  it.each(['smtp://', 'smtp://bad host', 'smtp://:::', 'smtp://h:99999', 'mail.example.com'])(
    'rejects malformed OWLWIRE_SMTP_URL %s',
    (url) => {
      expect(() =>
        loadAuthEnv({
          OWLWIRE_AUTH_SECRET: SECRET,
          OWLWIRE_SMTP_URL: url,
          OWLWIRE_SMTP_FROM: 'a@b.c',
        }),
      ).toThrow(/OWLWIRE_SMTP_URL/);
    },
  );

  it.each(['0', '70000', '-1', '80.5', 'abc'])('rejects OWLWIRE_PORT %s', (port) => {
    expect(() => loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET, OWLWIRE_PORT: port })).toThrow(
      /OWLWIRE_PORT/,
    );
  });

  it('rejects a repetitive secret and trims whitespace around values', () => {
    expect(() => loadAuthEnv({ OWLWIRE_AUTH_SECRET: 'a'.repeat(32) })).toThrow(/repetitive/);
    expect(() => loadAuthEnv({ OWLWIRE_AUTH_SECRET: `${' '.repeat(31)}a` })).toThrow(/at least 32/);
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: `${SECRET}\n`,
      OWLWIRE_PUBLIC_URL: ' https://owl.example.com ',
    });
    expect(env.secret).toBe(SECRET);
    expect(env.baseURL).toBe('https://owl.example.com');
  });

  it('treats whitespace-only values as unset and ignores a sender without smtp url', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_PUBLIC_URL: '   ',
      OWLWIRE_SMTP_FROM: 'a@b.c',
      OWLWIRE_GITHUB_CLIENT_ID: '  ',
    });
    expect(env.publicUrlConfigured).toBe(false);
    expect(env.smtp).toBeNull();
    expect(env.social.github).toBeNull();
  });

  it('reports every problem in one pass', () => {
    let message = '';
    try {
      loadAuthEnv({
        OWLWIRE_PORT: '0',
        OWLWIRE_GOOGLE_CLIENT_ID: 'g',
        OWLWIRE_SMTP_URL: 'smtp://mail',
      });
    } catch (err) {
      message = (err as Error).message;
    }
    for (const name of [
      'OWLWIRE_AUTH_SECRET',
      'OWLWIRE_PORT',
      'OWLWIRE_SMTP_FROM',
      'OWLWIRE_GOOGLE_CLIENT_SECRET',
    ]) {
      expect(message).toContain(name);
    }
  });

  it('keeps secrets out of JSON and inspect output but readable by property', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_SMTP_URL: 'smtp://u:smtp-pass@mail:587',
      OWLWIRE_SMTP_FROM: 'a@b.c',
      OWLWIRE_GITHUB_CLIENT_ID: 'gh-id',
      OWLWIRE_GITHUB_CLIENT_SECRET: 'gh-secret',
    });
    for (const text of [
      JSON.stringify(env),
      JSON.stringify({ config: env }),
      JSON.stringify(env.social),
      JSON.stringify(env.smtp),
      inspect(env, { depth: 5 }),
      `${inspect(env.social.github)}`,
    ]) {
      for (const secret of [SECRET, 'smtp-pass', 'gh-secret']) expect(text).not.toContain(secret);
    }
    expect(JSON.stringify(env)).toContain('gh-id');
    expect(env.secret).toBe(SECRET);
    expect(env.smtp?.url).toBe('smtp://u:smtp-pass@mail:587');
    expect(env.social.github?.clientSecret).toBe('gh-secret');
  });
});
