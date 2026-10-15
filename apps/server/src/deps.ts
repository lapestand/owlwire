import { systemClock } from '@owlwire/core';
import { createKeyring } from '@owlwire/crypto';
import { openDatabase } from '@owlwire/db';
import pg from 'pg';
import { buildDefaultAdapters, createAdapterRegistry } from './adapters/registry.js';
import { type Auth, type AuthHooks, createAuth } from './auth/auth.js';
import { createAuthHooks } from './auth/hooks.js';
import type { BaseDeps } from './base-deps.js';
import type { AuthEnv } from './config/auth-env.js';
import type { ServerConfig } from './config/load.js';
import { createLogger, toAdapterLogger } from './logger.js';
import { createMailerFromEnv, type Mailer } from './mail/mailer.js';

export type { BaseDeps };

export type Deps = BaseDeps & { authEnv: AuthEnv; mailer: Mailer | null; auth: Auth };

/**
 * Builds the auth library on top of the base dependencies; `hooks` sees the base. The default hooks enforce the
 * registration mode and create the personal workspace of every new user.
 */
export function attachAuth(
  base: BaseDeps,
  authEnv: AuthEnv,
  mailer: Mailer | null,
  hooks: (base: BaseDeps) => AuthHooks = createAuthHooks,
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
