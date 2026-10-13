import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { createDb } from './client.js';

/** "owlw" — every process that migrates takes this session-level advisory lock first. */
export const MIGRATION_LOCK_KEY = 0x6f776c77;

/**
 * Resolves to packages/db/drizzle from src/ and dist/; inside the bundled server
 * (apps/server/dist/main.js) it resolves to apps/server/drizzle, where the build copies it.
 */
export const defaultMigrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Runs fn while holding a session-level advisory lock on a dedicated pool client.
 * The lock holder occupies one connection for the whole call, so N concurrent callers
 * on the same pool need a pool size of at least N+1 when fn itself uses the pool.
 * If unlocking fails the client is destroyed (ending the session releases the lock)
 * and fn's own error, when there is one, is the one rethrown.
 */
export async function withAdvisoryLock<T>(
  pool: pg.Pool,
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [key]);
  } catch (lockErr) {
    client.release(lockErr instanceof Error ? lockErr : true);
    throw lockErr;
  }
  let result: T | undefined;
  let fnErr: unknown;
  let failed = false;
  try {
    result = await fn();
  } catch (err) {
    failed = true;
    fnErr = err;
  }
  try {
    await client.query('select pg_advisory_unlock($1)', [key]);
  } catch (unlockErr) {
    client.release(unlockErr instanceof Error ? unlockErr : true);
    throw failed ? fnErr : unlockErr;
  }
  client.release();
  if (failed) throw fnErr;
  return result as T;
}

export interface MigrateOptions {
  migrationsFolder?: string;
  afterMigrate?: () => Promise<void>;
}

/** The pool needs at least two connections: one holds the lock, one runs the migration. */
export async function runMigrations(pool: pg.Pool, opts: MigrateOptions = {}): Promise<void> {
  await withAdvisoryLock(pool, MIGRATION_LOCK_KEY, async () => {
    await migrate(createDb(pool), {
      migrationsFolder: opts.migrationsFolder ?? defaultMigrationsFolder,
    });
    if (opts.afterMigrate) await opts.afterMigrate();
  });
}
