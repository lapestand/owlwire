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

export async function withAdvisoryLock<T>(
  pool: pg.Pool,
  key: number,
  fn: () => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [key]);
    try {
      return await fn();
    } finally {
      await client.query('select pg_advisory_unlock($1)', [key]);
    }
  } finally {
    client.release();
  }
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
