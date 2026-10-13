import { type Clock, systemClock } from '@owlwire/core';
import { createKeyring, type Keyring } from '@owlwire/crypto';
import { type OwlwireDb, openDatabase } from '@owlwire/db';
import pg from 'pg';
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
  /** Application role pool for Graphile Worker (and P1e leader election). Data access goes through deps.db. */
  pool: pg.Pool;
  db: OwlwireDb;
  keyring: Keyring;
  clock: Clock;
  logger: Logger;
  adapters: AdapterRegistry;
  rand: () => number;
}

/** Close with `await deps.db.close(); await deps.pool.end();` (R68). */
export function createDeps(
  config: ServerConfig,
  overrides: Partial<Omit<Deps, 'config'>> = {},
): Deps {
  if (overrides.db && !overrides.pool) {
    // P0 carry-over: a db override without a pool override used to open an unrelated, unused pool.
    throw new TypeError('createDeps: overriding db requires overriding pool as well');
  }
  const logger = overrides.logger ?? createLogger(config.logLevel);
  let pool = overrides.pool;
  if (!pool) {
    // Same limits as the @owlwire/db handle's pool: a bounded size and a 5 s connect timeout (P0 Task 0 V5).
    pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
    });
    // Unhandled 'error' events on the pool or on a checked-out client kill the process.
    pool.on('error', (err) => logger.error({ err }, 'idle database client error'));
    pool.on('connect', (client) => {
      client.on('error', (err) => logger.error({ err }, 'database client error'));
    });
  }
  const clock = overrides.clock ?? systemClock;
  const keyring = overrides.keyring ?? createKeyring(config.kek.current, config.kek.previous);
  const db =
    overrides.db ??
    openDatabase({
      url: config.databaseUrl,
      keyring,
      clock,
      onPoolError: (err) => logger.error({ err }, 'database client error'),
    });
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
    keyring,
    clock,
    logger,
    adapters,
    rand: overrides.rand ?? Math.random,
  };
}
