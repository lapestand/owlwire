import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './load.js';

const KEK = randomBytes(32).toString('base64');
const base = { OWLWIRE_DATABASE_URL: 'postgres://u:p@localhost:5432/owlwire', OWLWIRE_KEK: KEK };
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
      devAdminToken: null,
      devFakeAdapter: false,
    });
    expect(c.kek.current.version).toBe(1);
    expect(c.kek.previous).toBeNull();
    expect(c.edition.profile).toBe('personal');
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
        OWLWIRE_DEV_ADMIN_TOKEN: 'd'.repeat(24),
        OWLWIRE_DEV_FAKE_ADAPTER: '1',
      },
      noFile,
    );
    expect(c).toMatchObject({
      role: 'worker',
      port: 9090,
      publicUrl: 'https://owl.example.com',
      logLevel: 'debug',
      telegramBotToken: '1:shared',
      devAdminToken: 'd'.repeat(24),
      devFakeAdapter: true,
    });
  });

  it('rejects invalid values', () => {
    expect(() => loadConfig({ ...base, OWLWIRE_ROLE: 'scheduler' }, noFile)).toThrow(
      /OWLWIRE_ROLE/,
    );
    expect(() => loadConfig({ ...base, OWLWIRE_PORT: '0' }, noFile)).toThrow(/OWLWIRE_PORT/);
    expect(() => loadConfig({ ...base, OWLWIRE_DATABASE_URL: 'mysql://x' }, noFile)).toThrow(
      /OWLWIRE_DATABASE_URL/,
    );
    expect(() => loadConfig({ ...base, OWLWIRE_DEV_ADMIN_TOKEN: 'short' }, noFile)).toThrow(
      /OWLWIRE_DEV_ADMIN_TOKEN/,
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
});
