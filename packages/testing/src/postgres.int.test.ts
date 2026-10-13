import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase, pgAdminUrl } from './index.js';

describe('createTestDatabase', () => {
  it('creates an isolated database and drops it', async () => {
    const db = await createTestDatabase(pgAdminUrl());
    const client = new pg.Client({ connectionString: db.url });
    await client.connect();
    const { rows } = await client.query<{ name: string }>('select current_database() as name');
    await client.end();
    expect(rows[0]?.name).toMatch(/^t_[0-9a-f]{12}$/);

    await db.drop();
    const admin = new pg.Client({ connectionString: pgAdminUrl() });
    await admin.connect();
    const left = await admin.query('select 1 from pg_database where datname = $1', [rows[0]?.name]);
    await admin.end();
    expect(left.rowCount).toBe(0);
  });

  it('gives every call a different database', async () => {
    const a = await createTestDatabase(pgAdminUrl());
    const b = await createTestDatabase(pgAdminUrl());
    expect(a.url).not.toBe(b.url);
    await a.drop();
    await b.drop();
  });
});
