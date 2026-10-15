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
import { type Auth, type AuthHooks, createAuth, noopAuthHooks } from './auth/auth.js';
import type { AuthEnv } from './config/auth-env.js';
import type { ServerConfig } from './config/load.js';
import { createLogger, toAdapterLogger } from './logger.js';
import { createMailerFromEnv, type Mailer } from './mail/mailer.js';

export interface BaseDeps {
  config: ServerConfig;
  /** Application role pool for Graphile Worker (and, later, leader election). Data access goes through deps.db. */
  pool: pg.Pool;
  db: OwlwireDb;
  /**
   * Auth role handle (owlwire_auth): the auth library's adapter and the auth_user system functions only. The
   * application role behind `db` cannot read sessions, credentials or tokens.
   */
  authDb: OwlwireDb;
  keyring: Keyring;
  clock: Clock;
  logger: Logger;
  adapters: AdapterRegistry;
  rand: () => number;
}

export type Deps = BaseDeps & { authEnv: AuthEnv; mailer: Mailer | null; auth: Auth };

/** Builds the auth library on top of the base dependencies; `hooks` sees the base (registration gates, workspaces). */
export function attachAuth(
  base: BaseDeps,
  authEnv: AuthEnv,
  mailer: Mailer | null,
  hooks: (base: BaseDeps) => AuthHooks = () => noopAuthHooks,
): Deps {
  const auth = createAuth({
    db: base.authDb,
    env: authEnv,
    mailer,
    logger: base.logger,
    hooks: hooks(base),
  });
  return { ...base, authEnv, mailer, auth };
}

/** Close with `await closeDeps(deps)`. */
export async function closeDeps(deps: Pick<BaseDeps, 'db' | 'authDb' | 'pool'>): Promise<void> {
  await deps.db.close();
  if (deps.authDb !== deps.db) await deps.authDb.close();
  await deps.pool.end();
}

export function createDeps(
  config: ServerConfig,
  overrides: Partial<Omit<Deps, 'config'>> = {},
): Deps {
  if (overrides.db && !overrides.pool) {
    // A db override without a pool override must not open an unrelated, unused pool.
    throw new TypeError('createDeps: overriding db requires overriding pool as well');
  }
  const logger = overrides.logger ?? createLogger(config.logLevel);
  let pool = overrides.pool;
  if (!pool) {
    // Same limits as the @owlwire/db handle's pool: a bounded size and a 5 s connect timeout.
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
  const authDb =
    overrides.authDb ??
    openDatabase({
      url: config.authDatabaseUrl ?? config.databaseUrl,
      keyring,
      clock,
      // The auth library makes few, short queries; a small pool keeps the extra role cheap.
      maxConnections: 5,
      onPoolError: (err) => logger.error({ err }, 'auth database client error'),
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
  const base: BaseDeps = {
    config,
    pool,
    db,
    authDb,
    keyring,
    clock,
    logger,
    adapters,
    rand: overrides.rand ?? Math.random,
  };
  const mailer =
    overrides.mailer !== undefined ? overrides.mailer : createMailerFromEnv(config.authEnv);
  return attachAuth(base, config.authEnv, mailer);
}
