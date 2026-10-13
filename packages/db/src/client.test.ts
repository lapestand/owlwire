import { afterEach, describe, expect, it } from 'vitest';
import { createPool } from './client.js';

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
