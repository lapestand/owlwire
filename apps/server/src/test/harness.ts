import { type ChannelAdapter, createFakeAdapter, type FakeAdapter } from '@owlwire/adapter-sdk';
import { type Clock, systemClock } from '@owlwire/core';
import { migrateAll } from '@owlwire/db/migrate';
import { startTestDatabase } from '@owlwire/testing';
import type { Hono } from 'hono';
import pg from 'pg';
import { createAdapterRegistry } from '../adapters/registry.js';
import type { AuthHooks } from '../auth/auth.js';
import type { ServerConfig } from '../config/load.js';
import { attachAuth, type BaseDeps, closeDeps, createDeps, type Deps } from '../deps.js';
import { createApp } from '../http/app.js';
import type { AppEnv } from '../http/types.js';
import type { Mailer } from '../mail/mailer.js';
import { testAuthEnv, testConfig } from './config.js';

export interface Harness {
  deps: Deps;
  app: Hono<AppEnv>;
  fake: FakeAdapter;
  /** Owner role (owlwire) pool: raw SQL seeds and assertions outside RLS. Production code never uses it. */
  ownerPool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Three-role test database: migrated by the owner role in a fresh database of the global container; the
 * server connects as the application role (owlwire_app), so RLS applies exactly as in production, and the auth
 * library connects as the auth role (owlwire_auth). Without `auth.mailer` no mail is sent (email disabled).
 */
export async function createHarness(
  opts: {
    clock?: Clock;
    adapters?: ChannelAdapter[];
    rand?: () => number;
    config?: Partial<ServerConfig>;
    auth?: {
      smtp?: boolean;
      env?: Record<string, string>;
      mailer?: Mailer | null;
      hooks?: (base: BaseDeps) => AuthHooks;
    };
  } = {},
): Promise<Harness> {
  const tdb = await startTestDatabase({ migrate: migrateAll });
  const fake = createFakeAdapter('webhook');
  const authEnv = testAuthEnv({
    smtp: opts.auth?.smtp ?? false,
    ...(opts.auth?.env ? { env: opts.auth.env } : {}),
  });
  const config = testConfig(tdb.appUrl, {
    migrationDatabaseUrl: tdb.ownerUrl,
    authDatabaseUrl: tdb.authUrl,
    authEnv,
    ...opts.config,
  });
  let deps = createDeps(config, {
    clock: opts.clock ?? systemClock,
    adapters: createAdapterRegistry(opts.adapters ?? [fake]),
    rand: opts.rand ?? (() => 0.5),
    mailer: opts.auth?.mailer ?? null,
  });
  if (opts.auth?.hooks) deps = attachAuth(deps, config.authEnv, deps.mailer, opts.auth.hooks);
  const ownerPool = new pg.Pool({ connectionString: tdb.ownerUrl, max: 2 });
  ownerPool.on('error', () => undefined);
  const app = createApp({ ...deps, webDir: null });
  return {
    deps,
    app,
    fake,
    ownerPool,
    close: async () => {
      await closeDeps(deps);
      await ownerPool.end();
      await tdb.stop();
    },
  };
}
