import { runMigrations } from '@owlwire/db';
import { runMigrations as runGraphileMigrations } from 'graphile-worker';
import type pg from 'pg';

/** Applies Drizzle and Graphile Worker migrations under one advisory lock. */
export async function migrateDatabase(pool: pg.Pool): Promise<void> {
  await runMigrations(pool, {
    afterMigrate: () => runGraphileMigrations({ pgPool: pool }),
  });
}
