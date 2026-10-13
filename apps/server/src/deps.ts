import { type Clock, systemClock } from '@owlwire/core';
import { createSecretBox, type SecretBox } from '@owlwire/crypto';
import { createDb, createPool, type Db } from '@owlwire/db';
import type pg from 'pg';
import type { Logger } from 'pino';
import {
  type AdapterRegistry,
  buildDefaultAdapters,
  createAdapterRegistry,
} from './adapters/registry.js';
import type { ServerConfig } from './config/load.js';
import { createLogger, toAdapterLogger } from './logger.js';

export interface Deps {
  config: ServerConfig;
  pool: pg.Pool;
  db: Db;
  clock: Clock;
  logger: Logger;
  crypto: SecretBox;
  adapters: AdapterRegistry;
  rand: () => number;
}

export function createDeps(
  config: ServerConfig,
  overrides: Partial<Omit<Deps, 'config'>> = {},
): Deps {
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const pool = overrides.pool ?? createPool(config.databaseUrl);
  const db = overrides.db ?? createDb(pool);
  const clock = overrides.clock ?? systemClock;
  const adapters =
    overrides.adapters ??
    createAdapterRegistry(
      buildDefaultAdapters(config, {
        logger: toAdapterLogger(logger.child({ component: 'adapter' })),
        fetch: globalThis.fetch,
        clock,
      }),
    );
  return {
    config,
    pool,
    db,
    clock,
    logger,
    crypto: overrides.crypto ?? createSecretBox(config.kek),
    adapters,
    rand: overrides.rand ?? Math.random,
  };
}
