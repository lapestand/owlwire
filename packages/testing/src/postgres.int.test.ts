import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDatabase, pgAdminUrl } from './index.js';

describe('createTestDatabase', () => {
  it('creates an isolated database and drops it', async () => {
    const db = await createTestDatabase(pgAdminUrl());
    let name: string | undefined;
    try {
      const client = new pg.Client({ connectionString: db.url });
      await client.connect();
      try {
        const { rows } = await client.query<{ name: string }>('select current_database() as name');
        name = rows[0]?.name;
      } finally {
        await client.end();
      }
      expect(name).toMatch(/^t_[0-9a-f]{12}$/);
    } finally {
      await db.drop();
    }
    const admin = new pg.Client({ connectionString: pgAdminUrl() });
    await admin.connect();
    try {
      const left = await admin.query('select 1 from pg_database where datname = $1', [name]);
      expect(left.rowCount).toBe(0);
    } finally {
      await admin.end();
    }
  });

  it('gives every call a different database', async () => {
    const a = await createTestDatabase(pgAdminUrl());
    try {
      const b = await createTestDatabase(pgAdminUrl());
      try {
        expect(a.url).not.toBe(b.url);
      } finally {
        await b.drop();
      }
    } finally {
      await a.drop();
    }
  });
});
