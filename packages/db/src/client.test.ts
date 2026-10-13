import { afterEach, describe, expect, it } from 'vitest';
import { createPool } from './client.js';
import * as root from './index.js';

describe('createPool', () => {
  let pool: ReturnType<typeof createPool> | undefined;
  afterEach(async () => {
    await pool?.end();
  });

  it('fails connection attempts after five seconds instead of waiting forever', () => {
    pool = createPool('postgres://u:p@127.0.0.1:1/db', 3);
    expect(pool.options).toMatchObject({
      connectionString: 'postgres://u:p@127.0.0.1:1/db',
      max: 3,
      connectionTimeoutMillis: 5_000,
    });
  });
});

describe('@owlwire/db root export', () => {
  it('hands out no raw pg pool or Drizzle instance (only the opaque OwlwireDb handle)', () => {
    expect(Object.keys(root)).not.toContain('createPool');
    expect(Object.keys(root)).not.toContain('createDb');
  });
});
