import { randomBytes } from 'node:crypto';
import { parseEditionConfig } from '@owlwire/core';
import { parseKek } from '@owlwire/crypto';
import { type AuthEnv, loadAuthEnv } from '../config/auth-env.js';
import type { ServerConfig } from '../config/load.js';

export const TEST_DEV_ADMIN_TOKEN = 'dev-admin-token-for-tests-0001';

export const TEST_BASE_URL = 'http://localhost:8080';
export const TEST_AUTH_SECRET = 'test-auth-secret-'.padEnd(48, 'x');

export function testAuthEnv(opts: { smtp?: boolean; env?: Record<string, string> } = {}): AuthEnv {
  return loadAuthEnv({
    OWLWIRE_AUTH_SECRET: TEST_AUTH_SECRET,
    OWLWIRE_PUBLIC_URL: TEST_BASE_URL,
    ...(opts.smtp
      ? {
          OWLWIRE_SMTP_URL: 'smtp://localhost:2525',
          OWLWIRE_SMTP_FROM: 'Owlwire <no-reply@owlwire.test>',
        }
      : {}),
    ...opts.env,
  });
}

/**
 * `databaseUrl` is the application role URL (owlwire_app, subject to RLS); the owner/migration URL and the auth role
 * URL come in through `overrides.migrationDatabaseUrl` and `overrides.authDatabaseUrl` (createHarness sets them).
 */
export function testConfig(
  databaseUrl: string,
  overrides: Partial<ServerConfig> = {},
): ServerConfig {
  return {
    databaseUrl,
    allowInsecureDbRole: false,
    kek: { current: parseKek(randomBytes(32).toString('base64'), 1), previous: null },
    role: 'all',
    port: 0,
    publicUrl: null,
    configPath: '/nonexistent/owlwire.yaml',
    logLevel: 'silent',
    telegramBotToken: null,
    devAdminToken: TEST_DEV_ADMIN_TOKEN,
    devFakeAdapter: false,
    edition: parseEditionConfig(undefined),
    trustedProxies: [],
    authEnv: testAuthEnv(),
    ...overrides,
  };
}
