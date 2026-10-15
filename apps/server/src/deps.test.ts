import { afterEach, describe, expect, it } from 'vitest';
import { closeDeps, createDeps, type Deps } from './deps.js';
import { testConfig } from './test/config.js';

let deps: Deps | undefined;
afterEach(async () => {
  if (deps) await closeDeps(deps);
  deps = undefined;
});

describe('createDeps', () => {
  it('logs idle pool client errors instead of crashing the process', () => {
    deps = createDeps(testConfig('postgres://user:pass@127.0.0.1:1/none'));
    expect(deps.pool.listenerCount('error')).toBeGreaterThan(0);
    expect(deps.pool.listenerCount('connect')).toBeGreaterThan(0);
    expect(() => deps?.pool.emit('error', new Error('connection reset'))).not.toThrow();
  });

  it('builds the worker pool with a bounded size and a connect timeout', () => {
    deps = createDeps(testConfig('postgres://user:pass@127.0.0.1:1/none'));
    expect(deps.pool.options).toMatchObject({ max: 10, connectionTimeoutMillis: 5_000 });
  });

  it('refuses a db override without a pool override instead of opening an unrelated pool', async () => {
    const config = testConfig('postgres://user:pass@127.0.0.1:1/none');
    const base = createDeps(config);
    try {
      expect(() => createDeps(config, { db: base.db })).toThrow(TypeError);
      const reused = createDeps(config, { db: base.db, pool: base.pool });
      expect(reused.db).toBe(base.db);
      expect(reused.pool).toBe(base.pool);
      await reused.authDb.close();
    } finally {
      await closeDeps(base);
    }
  });
});
