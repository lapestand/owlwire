import { afterEach, describe, expect, it } from 'vitest';
import { createDeps, type Deps } from './deps.js';
import { testConfig } from './test/config.js';

let deps: Deps | undefined;
afterEach(async () => {
  await deps?.pool.end();
  deps = undefined;
});

describe('createDeps', () => {
  it('logs idle pool client errors instead of crashing the process', () => {
    deps = createDeps(testConfig('postgres://user:pass@127.0.0.1:1/none'));
    expect(deps.pool.listenerCount('error')).toBeGreaterThan(0);
    expect(deps.pool.listenerCount('connect')).toBeGreaterThan(0);
    expect(() => deps?.pool.emit('error', new Error('connection reset'))).not.toThrow();
  });
});
