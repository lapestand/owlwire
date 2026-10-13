import { type ChannelAdapter, createFakeAdapter, type FakeAdapter } from '@owlwire/adapter-sdk';
import { type Clock, systemClock } from '@owlwire/core';
import { migrateAll } from '@owlwire/db/migrate';
import { startTestDatabase } from '@owlwire/testing';
import type { Hono } from 'hono';
import pg from 'pg';
import { createAdapterRegistry } from '../adapters/registry.js';
import type { ServerConfig } from '../config/load.js';
import { createDeps, type Deps } from '../deps.js';
import { createApp } from '../http/app.js';
import type { AppEnv } from '../http/types.js';
import { testConfig } from './config.js';

export interface Harness {
  deps: Deps;
  app: Hono<AppEnv>;
  fake: FakeAdapter;
  /** Owner role (owlwire) pool: raw SQL seeds and assertions outside RLS (R43). Production code never uses it. */
  ownerPool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Two-role test database (R36): migrated by the owner role in a fresh database of the global container (R51); the
 * server connects as the application role (owlwire_app), so RLS applies exactly as in production.
 */
export async function createHarness(
  opts: {
    clock?: Clock;
    adapters?: ChannelAdapter[];
    rand?: () => number;
    config?: Partial<ServerConfig>;
  } = {},
): Promise<Harness> {
  const tdb = await startTestDatabase({ migrate: migrateAll });
  const fake = createFakeAdapter('webhook');
  const deps = createDeps(
    testConfig(tdb.appUrl, { migrationDatabaseUrl: tdb.ownerUrl, ...opts.config }),
    {
      clock: opts.clock ?? systemClock,
      adapters: createAdapterRegistry(opts.adapters ?? [fake]),
      rand: opts.rand ?? (() => 0.5),
    },
  );
  const ownerPool = new pg.Pool({ connectionString: tdb.ownerUrl, max: 2 });
  ownerPool.on('error', () => undefined);
  const app = createApp({
    db: deps.db,
    clock: deps.clock,
    logger: deps.logger,
    config: deps.config,
    webDir: null,
  });
  return {
    deps,
    app,
    fake,
    ownerPool,
    close: async () => {
      await deps.db.close();
      await deps.pool.end();
      await ownerPool.end();
      await tdb.stop();
    },
  };
}
