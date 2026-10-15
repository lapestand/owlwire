import type { Clock } from '@owlwire/core';
import type { Keyring } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import type pg from 'pg';
import type { Logger } from 'pino';
import type { AdapterRegistry } from './adapters/registry.js';
import type { ServerConfig } from './config/load.js';

/**
 * The dependencies every server part shares, without the auth library. Kept apart from deps.ts so that code the auth
 * hooks reach (registration, personal workspaces) can name it without importing the module that builds the hooks.
 */
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
