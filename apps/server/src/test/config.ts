import { randomBytes } from 'node:crypto';
import { parseEditionConfig } from '@owlwire/core';
import { parseKek } from '@owlwire/crypto';
import type { ServerConfig } from '../config/load.js';

export const TEST_DEV_ADMIN_TOKEN = 'dev-admin-token-for-tests-0001';

/**
 * `databaseUrl` is the application role URL (owlwire_app, subject to RLS); the owner/migration URL comes in through
 * `overrides.migrationDatabaseUrl` (createHarness sets it).
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
    ...overrides,
  };
}
