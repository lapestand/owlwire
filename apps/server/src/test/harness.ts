import { type ChannelAdapter, createFakeAdapter, type FakeAdapter } from '@owlwire/adapter-sdk';
import { type Clock, systemClock } from '@owlwire/core';
import { createTestDatabase, pgAdminUrl } from '@owlwire/testing';
import type { Hono } from 'hono';
import { createAdapterRegistry } from '../adapters/registry.js';
import type { ServerConfig } from '../config/load.js';
import { createDeps, type Deps } from '../deps.js';
import { createApp } from '../http/app.js';
import type { AppEnv } from '../http/types.js';
import { migrateDatabase } from '../system/migrate.js';
import { testConfig } from './config.js';

export interface Harness {
  deps: Deps;
  app: Hono<AppEnv>;
  fake: FakeAdapter;
  close(): Promise<void>;
}

export async function createHarness(
  opts: {
    clock?: Clock;
    adapters?: ChannelAdapter[];
    rand?: () => number;
    config?: Partial<ServerConfig>;
  } = {},
): Promise<Harness> {
  const testDb = await createTestDatabase(pgAdminUrl());
  const fake = createFakeAdapter('webhook');
  const deps = createDeps(testConfig(testDb.url, opts.config), {
    clock: opts.clock ?? systemClock,
    adapters: createAdapterRegistry(opts.adapters ?? [fake]),
    rand: opts.rand ?? (() => 0.5),
  });
  await migrateDatabase(deps.pool);
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
    close: async () => {
      await deps.pool.end();
      await testDb.drop();
    },
  };
}
