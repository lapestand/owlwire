import { EventEmitter } from 'node:events';
import { FakeClock } from '@owlwire/core';
import { createKeyring, generateKek } from '@owlwire/crypto';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { dbInternals, openDatabase } from './handle.js';

describe('openDatabase', () => {
  it('uses the standard pool settings and routes pool errors to onPoolError instead of crashing', async () => {
    const seen: Error[] = [];
    const db = openDatabase({
      url: 'postgres://u:p@127.0.0.1:1/none',
      keyring: createKeyring(generateKek(1)),
      clock: new FakeClock(new Date(0)),
      maxConnections: 2,
      onPoolError: (err) => seen.push(err),
    });
    const { pool } = dbInternals(db);
    expect(pool.options.connectionTimeoutMillis).toBe(5_000);
    expect(pool.options.max).toBe(2);
    expect(pool.listenerCount('connect')).toBeGreaterThan(0);
    expect(() => pool.emit('error', new Error('connection reset'))).not.toThrow();
    expect(seen.map((e) => e.message)).toEqual(['connection reset']);
    await db.close();
  });

  it('reports an idle client error once and a checked-out client error once', async () => {
    const seen: Error[] = [];
    const db = openDatabase({
      url: 'postgres://u:p@127.0.0.1:1/none',
      keyring: createKeyring(generateKek(1)),
      clock: new FakeClock(new Date(0)),
      onPoolError: (err) => seen.push(err),
    });
    const { pool } = dbInternals(db);
    const client = new EventEmitter() as unknown as pg.PoolClient;
    pool.emit('connect', client);
    // Idle: pg-pool's own idle listener turns the client error into a pool 'error' event.
    const idle = new Error('idle reset');
    client.emit('error', idle);
    pool.emit('error', idle, client);
    expect(seen).toEqual([idle]);
    // Checked out: pg-pool removed its idle listener, only our client listener reports.
    pool.emit('acquire', client);
    const busy = new Error('busy reset');
    client.emit('error', busy);
    expect(seen).toEqual([idle, busy]);
    // Released again: idle path only.
    pool.emit('release', undefined, client);
    const idle2 = new Error('idle again');
    client.emit('error', idle2);
    pool.emit('error', idle2, client);
    expect(seen).toEqual([idle, busy, idle2]);
    await db.close();
  });

  it('close is idempotent', async () => {
    const db = openDatabase({
      url: 'postgres://u:p@127.0.0.1:1/none',
      keyring: createKeyring(generateKek(1)),
      clock: new FakeClock(new Date(0)),
    });
    await db.close();
    await expect(db.close()).resolves.toBeUndefined();
  });
});
