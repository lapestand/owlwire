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
 *
 * pg-pool stops listening for client 'error' events while a client is checked out, so
 * this function listens itself: if the server ends the session (57P01 on a restart or
 * pg_terminate_backend) the lock is gone, the error is surfaced instead of crashing the
 * process, and the client is destroyed. Whenever fn failed, fn's error wins.
 */
export async function withAdvisoryLock<T>(
  pool: pg.Pool,
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let lostErr: Error | undefined;
  const onError = (err: Error) => {
    lostErr ??= err;
  };
  client.on('error', onError);
  /** Passing an error destroys the client instead of returning it to the pool. */
  const release = (err?: unknown) => {
    client.off('error', onError);
    client.release(err === undefined ? undefined : err instanceof Error ? err : true);
  };

  try {
    await client.query('select pg_advisory_lock($1)', [key]);
  } catch (lockErr) {
    release(lostErr ?? lockErr ?? true);
    throw lostErr ?? lockErr;
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

  if (!lostErr) {
    try {
      await client.query('select pg_advisory_unlock($1)', [key]);
    } catch (unlockErr) {
      const err = lostErr ?? unlockErr;
      release(err ?? true);
      throw failed ? fnErr : err;
    }
  }
  if (lostErr) {
    // the session ended, which released the lock; the client is unusable
    release(lostErr);
    throw failed ? fnErr : lostErr;
  }
  release();
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
