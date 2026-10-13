import { FakeClock } from '@owlwire/core';
import { createKeyring, generateKek } from '@owlwire/crypto';
import { describe, expect, it } from 'vitest';
import { dbInternals, openDatabase } from './handle.js';

describe('openDatabase', () => {
  it('uses the P0 pool settings and routes pool errors to onPoolError instead of crashing', async () => {
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
});
