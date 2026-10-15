import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './load.js';

const KEK = randomBytes(32).toString('base64');
const base = {
  OWLWIRE_DATABASE_URL: 'postgres://u:p@localhost:5432/owlwire',
  OWLWIRE_KEK: KEK,
  OWLWIRE_AUTH_SECRET: `${'x'.repeat(16)}abcdefghijklmnop`,
};
const noFile = () => null;

describe('loadConfig', () => {
  it('applies defaults', () => {
    const c = loadConfig(base, noFile);
    expect(c).toMatchObject({
      databaseUrl: 'postgres://u:p@localhost:5432/owlwire',
      role: 'all',
      port: 8080,
      publicUrl: null,
      configPath: '/etc/owlwire/owlwire.yaml',
      logLevel: 'info',
      telegramBotToken: null,
    });
    expect(c).not.toHaveProperty('devAdminToken');
    expect(c).not.toHaveProperty('devFakeAdapter');
    expect(c.kek.current.version).toBe(1);
    expect(c.kek.previous).toBeNull();
    expect(c.edition.profile).toBe('personal');
  });

  it('fails with ConfigError when OWLWIRE_AUTH_SECRET is missing or short', () => {
    const { OWLWIRE_AUTH_SECRET: _omit, ...withoutSecret } = base;
    expect(() => loadConfig(withoutSecret, noFile)).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, OWLWIRE_AUTH_SECRET: 'short' }, noFile)).toThrow(
      /at least 32/,
    );
  });

  it('exposes the parsed auth environment', () => {
    expect(loadConfig(base, noFile).authEnv).toMatchObject({
      baseURL: 'http://localhost:8080',
      smtp: null,
    });
  });

  it('reads the auth role URL and the trusted proxies', () => {
    const c = loadConfig(
      {
        ...base,
        OWLWIRE_AUTH_DATABASE_URL: 'postgres://owlwire_auth:pw@localhost:5432/owlwire',
        OWLWIRE_TRUSTED_PROXIES: '10.0.0.5, 10.1.0.0/16',
      },
      noFile,
    );
    expect(c.authDatabaseUrl).toBe('postgres://owlwire_auth:pw@localhost:5432/owlwire');
    expect(c.trustedProxies).toEqual(['10.0.0.5', '10.1.0.0/16']);
    const defaults = loadConfig(base, noFile);
    expect(defaults.authDatabaseUrl).toBeUndefined();
    expect(defaults.trustedProxies).toEqual([]);
    expect(() => loadConfig({ ...base, OWLWIRE_AUTH_DATABASE_URL: 'mysql://x' }, noFile)).toThrow(
      /OWLWIRE_AUTH_DATABASE_URL/,
    );
    expect(() => loadConfig({ ...base, OWLWIRE_TRUSTED_PROXIES: 'proxy.local' }, noFile)).toThrow(
      ConfigError,
    );
  });

  it('reports every missing required variable', () => {
    expect(() => loadConfig({}, noFile)).toThrow(ConfigError);
    expect(() => loadConfig({}, noFile)).toThrow(/OWLWIRE_DATABASE_URL[\s\S]*OWLWIRE_KEK/);
  });

  it('treats empty strings from compose env files as unset', () => {
    const c = loadConfig(
      { ...base, OWLWIRE_PUBLIC_URL: '', OWLWIRE_PORT: '', OWLWIRE_ROLE: ' ', OWLWIRE_CONFIG: '' },
      noFile,
    );
    expect(c.publicUrl).toBeNull();
    expect(c.port).toBe(8080);
    expect(c.role).toBe('all');
    expect(() => loadConfig({ ...base, OWLWIRE_KEK: '' }, noFile)).toThrow(/OWLWIRE_KEK/);
  });

  it('parses explicit values', () => {
    const c = loadConfig(
      {
        ...base,
        OWLWIRE_ROLE: 'worker',
        OWLWIRE_PORT: '9090',
        OWLWIRE_PUBLIC_URL: 'https://owl.example.com',
        OWLWIRE_LOG_LEVEL: 'debug',
        OWLWIRE_TELEGRAM_BOT_TOKEN: '1:shared',
      },
      noFile,
    );
    expect(c).toMatchObject({
      role: 'worker',
      port: 9090,
      publicUrl: 'https://owl.example.com',
      logLevel: 'debug',
      telegramBotToken: '1:shared',
    });
  });

  it('ignores the removed development variables, whatever their value', () => {
    const c = loadConfig(
      { ...base, OWLWIRE_DEV_ADMIN_TOKEN: 'short', OWLWIRE_DEV_FAKE_ADAPTER: 'yes' },
      noFile,
    );
    expect(c).not.toHaveProperty('devAdminToken');
    expect(c).not.toHaveProperty('devFakeAdapter');
    expect(JSON.stringify(c)).not.toContain('OWLWIRE_DEV');
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ ...base, OWLWIRE_ROLE: 'scheduler' }, noFile)).toThrow(
      /OWLWIRE_ROLE/,
    );
    expect(() => loadConfig({ ...base, OWLWIRE_PORT: '0' }, noFile)).toThrow(/OWLWIRE_PORT/);
    expect(() => loadConfig({ ...base, OWLWIRE_DATABASE_URL: 'mysql://x' }, noFile)).toThrow(
      /OWLWIRE_DATABASE_URL/,
    );
  });

  it('rejects a bad KEK without echoing it', () => {
    const short = randomBytes(16).toString('base64');
    let message = '';
    try {
      loadConfig({ ...base, OWLWIRE_KEK: short }, noFile);
    } catch (err) {
      message = String(err);
    }
    expect(message).toMatch(/OWLWIRE_KEK/);
    expect(message).not.toContain(short);
  });

  it('loads a previous KEK for rotation and refuses a clashing version', () => {
    const other = randomBytes(32).toString('base64');
    const c = loadConfig(
      { ...base, OWLWIRE_KEK_VERSION: '2', OWLWIRE_KEK_PREVIOUS: `1:${other}` },
      noFile,
    );
    expect(c.kek.current.version).toBe(2);
    expect(c.kek.previous?.version).toBe(1);
    expect(() => loadConfig({ ...base, OWLWIRE_KEK_PREVIOUS: `1:${other}` }, noFile)).toThrow(
      /OWLWIRE_KEK_PREVIOUS/,
    );
  });

  it('rejects a malformed OWLWIRE_KEK_PREVIOUS without echoing it and treats an empty one as unset', () => {
    const secret = randomBytes(32).toString('base64');
    const errorOf = (fn: () => unknown): unknown => {
      try {
        fn();
      } catch (err) {
        return err;
      }
      return undefined;
    };
    for (const bad of ['garbage', `x:${secret}`, '1:', `1:${secret.slice(0, 12)}`, `0:${secret}`]) {
      const err = errorOf(() =>
        loadConfig({ ...base, OWLWIRE_KEK_VERSION: '2', OWLWIRE_KEK_PREVIOUS: bad }, noFile),
      );
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as Error).message).toMatch(/OWLWIRE_KEK_PREVIOUS/);
      expect((err as Error).message).not.toContain(secret.slice(0, 12));
    }
    for (const empty of ['', '   ']) {
      expect(loadConfig({ ...base, OWLWIRE_KEK_PREVIOUS: empty }, noFile).kek.previous).toBeNull();
    }
  });

  it('merges owlwire.yaml over defaults', () => {
    const c = loadConfig(base, (path) =>
      path === '/etc/owlwire/owlwire.yaml'
        ? 'profile: community\nplatforms:\n  telegram:\n    enabled: true\n'
        : null,
    );
    expect(c.edition.profile).toBe('community');
    expect(c.edition.platforms.telegram.enabled).toBe(true);
    expect(c.edition.platforms.webhook.enabled).toBe(true);
  });

  it('fails when an explicitly configured file is missing or invalid', () => {
    expect(() => loadConfig({ ...base, OWLWIRE_CONFIG: '/nope.yaml' }, noFile)).toThrow(
      /\/nope\.yaml/,
    );
    expect(() => loadConfig(base, () => 'profile: hosted\n')).toThrow(/owlwire\.yaml/);
    expect(() => loadConfig(base, () => 'profile: [unclosed\n')).toThrow(ConfigError);
  });

  it('reads the optional migration database url', () => {
    expect(
      loadConfig(
        { ...base, OWLWIRE_MIGRATION_DATABASE_URL: 'postgres://owlwire:pw@db:5432/owlwire' },
        noFile,
      ).migrationDatabaseUrl,
    ).toBe('postgres://owlwire:pw@db:5432/owlwire');
    expect(loadConfig(base, noFile).migrationDatabaseUrl).toBeUndefined();
    expect(() =>
      loadConfig({ ...base, OWLWIRE_MIGRATION_DATABASE_URL: 'mysql://x' }, noFile),
    ).toThrow(ConfigError);
  });

  it('reads the insecure database role opt-in (default off, only "true" or "false")', () => {
    expect(loadConfig(base, noFile).allowInsecureDbRole).toBe(false);
    expect(
      loadConfig({ ...base, OWLWIRE_ALLOW_INSECURE_DB_ROLE: 'true' }, noFile).allowInsecureDbRole,
    ).toBe(true);
    expect(
      loadConfig({ ...base, OWLWIRE_ALLOW_INSECURE_DB_ROLE: 'false' }, noFile).allowInsecureDbRole,
    ).toBe(false);
    expect(() => loadConfig({ ...base, OWLWIRE_ALLOW_INSECURE_DB_ROLE: 'yes' }, noFile)).toThrow(
      ConfigError,
    );
  });
});
