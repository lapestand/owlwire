import { sql } from 'drizzle-orm';
import { dbInternals, type OwlwireDb } from './handle.js';

/** /readyz: Graphile Worker şeması kurulu mu (migration'lar bitti mi). Kiracı tablosu okumaz. */
export async function isQueueSchemaReady(db: OwlwireDb): Promise<boolean> {
  const res = await dbInternals(db).drizzle.execute<{ ok: boolean }>(
    sql`select to_regclass('graphile_worker.jobs') is not null as ok`,
  );
  return res.rows[0]?.ok === true;
}
