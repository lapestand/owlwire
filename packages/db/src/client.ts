import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

/** Package-internal: the pool behind openDatabase (not exported from the package root). */
export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 5_000 });
}

/** Package-internal: the Drizzle instance the migrator runs on. */
export function createDb(pool: pg.Pool): NodePgDatabase<typeof schema> {
  return drizzle({ client: pool, schema });
}
