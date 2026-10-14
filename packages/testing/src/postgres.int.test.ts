import type { Socket } from 'node:net';
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

  it('waits for sessions that are still closing instead of terminating them', async () => {
    // pg-pool's end() resolves once its clients are detached, before the server has seen them go.
    // A forced drop in that window terminated those backends (57P01) and a pool without an 'error'
    // listener rethrew it as an uncaught exception. Holding back the Terminate message makes the
    // window deterministic.
    const db = await createTestDatabase(pgAdminUrl());
    const pool = new pg.Pool({ connectionString: db.url, max: 3 });
    const sockets: Socket[] = [];
    pool.on('connect', (client) => {
      sockets.push((client as unknown as { connection: { stream: Socket } }).connection.stream);
    });
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => uncaught.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      await Promise.all(Array.from({ length: 3 }, () => pool.query('select pg_sleep(0.05)')));
      expect(sockets).toHaveLength(3);
      for (const socket of sockets) socket.cork();
      await pool.end();
      const release = setTimeout(() => {
        for (const socket of sockets) socket.uncork();
      }, 300);
      try {
        await db.drop();
      } finally {
        clearTimeout(release);
        for (const socket of sockets) socket.uncork();
      }
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    expect(uncaught).toEqual([]);
  });

  it('still drops a database whose session never ends', async () => {
    const db = await createTestDatabase(pgAdminUrl());
    const leaked = new pg.Client({ connectionString: db.url });
    const errors: unknown[] = [];
    leaked.on('error', (err) => errors.push(err));
    await leaked.connect();
    try {
      await db.drop();
      for (let i = 0; i < 50 && errors.length === 0; i++)
        await new Promise((r) => setTimeout(r, 20));
      expect(errors[0]).toMatchObject({ code: '57P01' });
    } finally {
      await leaked.end().catch(() => undefined);
    }
  }, 30_000);
});
