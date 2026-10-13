import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema/index.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export type DbOrTx = Db | Tx;

export function createPool(url: string, max = 10): pg.Pool {
  return new pg.Pool({ connectionString: url, max, connectionTimeoutMillis: 5_000 });
}

export function createDb(pool: pg.Pool): Db {
  return drizzle({ client: pool, schema });
}
