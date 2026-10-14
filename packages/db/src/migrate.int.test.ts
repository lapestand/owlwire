import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '@owlwire/core';
import { createTestDatabase, pgAdminUrl, type ScratchDatabase } from '@owlwire/testing';
import { eq } from 'drizzle-orm';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, createPool } from './client.js';
import { pgErrorCode } from './errors.js';
import { defaultMigrationsFolder, runMigrations, withAdvisoryLock } from './migrate.js';
import {
  apps,
  connections,
  destinations,
  installations,
  rules,
  ruleTargets,
  workspaces,
} from './schema/index.js';

let tdb: ScratchDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  tdb = await createTestDatabase(pgAdminUrl());
  pool = createPool(tdb.url);
  await Promise.all([runMigrations(pool), runMigrations(pool), runMigrations(pool)]);
});

afterAll(async () => {
  await pool.end();
  await tdb.drop();
});

describe('runMigrations', () => {
  it('applies each migration exactly once even when started concurrently', async () => {
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: unknown[] };
    const { rows } = await pool.query<{ n: number }>(
      'select count(*)::int as n from drizzle.__drizzle_migrations',
    );
    expect(rows[0]?.n).toBe(journal.entries.length);
  });

  it('creates every base table', async () => {
    const { rows } = await pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(rows.map((r) => r.table_name)).toEqual(
      expect.arrayContaining([
        'workspaces',
        'connections',
        'destinations',
        'apps',
        'installations',
        'rules',
        'rule_targets',
        'events',
        'deliveries',
        'instance_settings',
      ]),
    );
  });
});

describe('withAdvisoryLock', () => {
  const KEY = 0x7465_7374;

  function within<T>(p: Promise<T>, ms: number): Promise<T> {
    return Promise.race([
      p,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('lock not acquired')), ms),
      ),
    ]);
  }

  async function terminateLockHolder(key: number): Promise<void> {
    await pool.query(
      `select pg_terminate_backend(pid) from pg_locks
       where locktype = 'advisory' and objid = $1 and granted
         and database = (select oid from pg_database where datname = current_database())`,
      [key],
    );
  }

  /** Collects uncaught exceptions (an unhandled pg client 'error' event lands here). */
  async function captureUncaught(run: () => Promise<void>): Promise<unknown[]> {
    const seen: unknown[] = [];
    const onUncaught = (err: unknown) => seen.push(err);
    process.on('uncaughtException', onUncaught);
    try {
      await run();
      // give the terminated socket time to emit its 'error' event
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      process.off('uncaughtException', onUncaught);
    }
    return seen;
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('rejects with the lost session error, without an unhandled client error, when the lock holder is terminated', async () => {
    const pool1 = createPool(tdb.url, 2);
    const pool2 = createPool(tdb.url, 2);
    try {
      const uncaught = await captureUncaught(async () => {
        const err = await withAdvisoryLock(pool1, KEY, async () => {
          await terminateLockHolder(KEY);
          await sleep(300);
          return 'ok';
        }).catch((e: unknown) => e);
        expect(pgErrorCode(err)).toBe('57P01');
      });
      expect(uncaught).toEqual([]);
      expect(pool1.totalCount).toBe(0);
      await expect(
        within(
          withAdvisoryLock(pool2, KEY, async () => 'ok'),
          2_000,
        ),
      ).resolves.toBe('ok');
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });

  it('releases the lock when fn throws so another pool acquires it immediately', async () => {
    const pool1 = createPool(tdb.url, 2);
    const pool2 = createPool(tdb.url, 2);
    try {
      await expect(
        withAdvisoryLock(pool1, KEY, async () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      await expect(
        within(
          withAdvisoryLock(pool2, KEY, async () => 'ok'),
          2_000,
        ),
      ).resolves.toBe('ok');
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });

  it('keeps the fn error and destroys the client when unlocking fails', async () => {
    const pool1 = createPool(tdb.url, 2);
    const pool2 = createPool(tdb.url, 2);
    try {
      const uncaught = await captureUncaught(async () => {
        await expect(
          withAdvisoryLock(pool1, KEY, async () => {
            await terminateLockHolder(KEY);
            await sleep(300);
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
      });
      expect(uncaught).toEqual([]);
      expect(pool1.totalCount).toBe(0);
      await expect(
        within(
          withAdvisoryLock(pool2, KEY, async () => 'ok'),
          2_000,
        ),
      ).resolves.toBe('ok');
    } finally {
      await pool1.end();
      await pool2.end();
    }
  });
});

describe('constraints', () => {
  const db = () => createDb(pool);

  async function workspaceWithConnection() {
    const ws = newId();
    const conn = newId();
    await db()
      .insert(workspaces)
      .values({ id: ws, name: 'W', slug: `w-${ws}`, kind: 'community' });
    await db().insert(connections).values({
      id: conn,
      workspaceId: ws,
      platform: 'telegram',
      kind: 'own_bot',
      displayName: 'b',
    });
    return { ws, conn };
  }

  it('applies column defaults', async () => {
    const { conn } = await workspaceWithConnection();
    const [row] = await db().select().from(connections).where(eq(connections.id, conn));
    expect(row?.status).toBe('pending');
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('treats a null external_sub_id as a value in the destination unique index', async () => {
    const { ws, conn } = await workspaceWithConnection();
    const base = {
      workspaceId: ws,
      connectionId: conn,
      kind: 'group',
      externalId: '-100',
      name: 'g',
    };
    await db()
      .insert(destinations)
      .values({ id: newId(), ...base });
    const err = await db()
      .insert(destinations)
      .values({ id: newId(), ...base })
      .catch((e: unknown) => e);
    expect(pgErrorCode(err)).toBe('23505');
    await db()
      .insert(destinations)
      .values({ id: newId(), ...base, externalSubId: '7' });
  });

  it('rejects unknown enum values and rule targets without exactly one target', async () => {
    const { ws } = await workspaceWithConnection();
    const badKind = await db()
      .insert(workspaces)
      .values({ id: newId(), name: 'X', slug: `x-${newId()}`, kind: 'hosted' })
      .catch((e: unknown) => e);
    expect(pgErrorCode(badKind)).toBe('23514');

    const appId = newId();
    const instId = newId();
    const ruleId = newId();
    await db()
      .insert(apps)
      .values({
        id: appId,
        ownerWorkspaceId: ws,
        name: 'A',
        slug: `a-${appId}`,
        visibility: 'private',
      });
    await db()
      .insert(installations)
      .values({
        id: instId,
        appId,
        workspaceId: ws,
        tokenHash: `h-${instId}`,
        tokenPrefix: 'ow_inst_xxxx',
      });
    await db()
      .insert(rules)
      .values({ id: ruleId, workspaceId: ws, installationId: instId, name: 'r', types: ['*'] });
    const noTarget = await db()
      .insert(ruleTargets)
      .values({ id: newId(), workspaceId: ws, ruleId })
      .catch((e: unknown) => e);
    expect(pgErrorCode(noTarget)).toBe('23514');
  });
});
