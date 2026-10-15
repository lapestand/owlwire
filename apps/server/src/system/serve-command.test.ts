import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { testConfig } from '../test/config.js';
import { type RunningServer, runServeCommand, type ServeCommandHooks } from './serve.js';
import { LegacyKeyringCoverageError } from './startup-checks.js';

const config = () => testConfig('postgres://u:p@127.0.0.1:1/none');
const silent = createLogger('silent');

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(over: Partial<ServeCommandHooks> = {}) {
  const handlers = new Map<string, () => void>();
  const exits: number[] = [];
  const hooks: ServeCommandHooks = {
    onSignal: (signal, handler) => handlers.set(signal, handler),
    exit: (code) => exits.push(code),
    migrate: async () => 'separate',
    startupChecks: async () => undefined,
    upgrade: async () => ({ keysCreated: 0, upgraded: 0, failed: [] }),
    nodeEnv: 'test',
    ...over,
  };
  return { handlers, exits, hooks };
}

describe('runServeCommand', () => {
  it('registers signal handlers before migrating and shuts down cleanly on SIGTERM during migration', async () => {
    let handlersAtMigrate: string[] = [];
    const { handlers, exits, hooks } = harness({
      migrate: () => {
        handlersAtMigrate = [...handlers.keys()].sort();
        return new Promise(() => undefined); // the migration never finishes
      },
    });
    void runServeCommand(config(), silent, null, hooks);
    await vi.waitFor(() => expect(handlersAtMigrate).toEqual(['SIGINT', 'SIGTERM']));
    handlers.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  it('does not start anything when the migration finishes after a shutdown signal', async () => {
    const migration = deferred<'separate'>();
    const start = vi.fn();
    const { handlers, exits, hooks } = harness({ migrate: () => migration.promise, start });
    const done = runServeCommand(config(), silent, null, hooks);
    await vi.waitFor(() => expect(handlers.size).toBe(2));
    handlers.get('SIGINT')?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    migration.resolve('separate');
    await expect(done).resolves.toBeUndefined();
    expect(start).not.toHaveBeenCalled();
    expect(exits).toEqual([0]);
  });

  it('waits for an in-flight legacy secret upgrade, then exits 0 once without starting the server', async () => {
    const upgrade = deferred<{ keysCreated: number; upgraded: number; failed: [] }>();
    const start = vi.fn();
    const { handlers, exits, hooks } = harness({ upgrade: () => upgrade.promise, start });
    const done = runServeCommand(config(), silent, null, hooks);
    await vi.waitFor(() => expect(handlers.size).toBe(2));
    await new Promise((r) => setTimeout(r, 10));
    handlers.get('SIGTERM')?.();
    await new Promise((r) => setTimeout(r, 20));
    // Still waiting for the upgrade: deps are not closed underneath it and nothing exited yet.
    expect(exits).toEqual([]);
    // The interrupted step fails (e.g. "pool ended"); that must not turn into a second exit.
    upgrade.reject(new Error('Cannot use a pool after calling end on the pool'));
    await expect(done).resolves.toBeUndefined();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(start).not.toHaveBeenCalled();
  });

  it('waits for an in-flight startServer and stops the server it started, exiting 0 once', async () => {
    const started = deferred<RunningServer>();
    const stopServer = vi.fn(async () => undefined);
    const { handlers, exits, hooks } = harness({ start: () => started.promise });
    const done = runServeCommand(config(), silent, null, hooks);
    await vi.waitFor(() => expect(handlers.size).toBe(2));
    await new Promise((r) => setTimeout(r, 10));
    handlers.get('SIGTERM')?.();
    handlers.get('SIGINT')?.(); // a second signal is ignored
    await new Promise((r) => setTimeout(r, 20));
    expect(exits).toEqual([]);
    started.resolve({ port: 1234, worker: null, stop: stopServer });
    await expect(done).resolves.toBeUndefined();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(stopServer).toHaveBeenCalledTimes(1);
  });

  it('refuses to start when legacy secrets need a KEK version the keyring lacks', async () => {
    const start = vi.fn();
    const { handlers, exits, hooks } = harness({
      upgrade: async () => ({
        keysCreated: 0,
        upgraded: 1,
        failed: [
          { connectionId: 'c1', error: 'x', missingKekVersion: 3 },
          { connectionId: 'c2', error: 'y', missingKekVersion: 3 },
          { connectionId: 'c3', error: 'DecryptError' },
        ],
      }),
      start,
    });
    const err = await runServeCommand(config(), silent, null, hooks).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LegacyKeyringCoverageError);
    expect((err as LegacyKeyringCoverageError).missingKekVersions).toEqual([3]);
    expect(start).not.toHaveBeenCalled();
    handlers.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  it('starts when legacy failures are not caused by a missing KEK version', async () => {
    const stop = vi.fn(async () => undefined);
    const { handlers, exits, hooks } = harness({
      upgrade: async () => ({
        keysCreated: 0,
        upgraded: 0,
        failed: [{ connectionId: 'c3', error: 'DecryptError' }],
      }),
      start: async () => ({ port: 1, worker: null, stop }),
    });
    await runServeCommand(config(), silent, null, hooks);
    handlers.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('passes both database handles, the insecure database role opt-in and NODE_ENV to the startup checks', async () => {
    const startupChecks = vi.fn(async () => undefined);
    const stop = vi.fn(async () => undefined);
    const { handlers, exits, hooks } = harness({
      startupChecks,
      nodeEnv: 'development',
      start: async () => ({ port: 1, worker: null, stop }),
    });
    await runServeCommand({ ...config(), allowInsecureDbRole: true }, silent, null, hooks);
    expect(startupChecks).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ allowInsecureDbRole: true, nodeEnv: 'development' }),
    );
    handlers.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
