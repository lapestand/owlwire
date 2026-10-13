import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '../logger.js';
import { testConfig } from '../test/config.js';
import { runServeCommand } from './serve.js';

describe('runServeCommand', () => {
  it('registers signal handlers before migrating and shuts down cleanly on SIGTERM during migration', async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    let handlersAtMigrate: string[] = [];
    void runServeCommand(
      testConfig('postgres://u:p@127.0.0.1:1/none'),
      createLogger('silent'),
      null,
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        exit: (code) => exits.push(code),
        migrate: () => {
          handlersAtMigrate = [...handlers.keys()].sort();
          return new Promise(() => undefined); // the migration never finishes
        },
      },
    );
    await vi.waitFor(() => expect(handlersAtMigrate).toEqual(['SIGINT', 'SIGTERM']));
    handlers.get('SIGTERM')?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));
  });

  it('does not start anything when the migration finishes after a shutdown signal', async () => {
    const handlers = new Map<string, () => void>();
    const exits: number[] = [];
    let finishMigration: (() => void) | undefined;
    const done = runServeCommand(
      testConfig('postgres://u:p@127.0.0.1:1/none'),
      createLogger('silent'),
      null,
      {
        onSignal: (signal, handler) => handlers.set(signal, handler),
        exit: (code) => exits.push(code),
        migrate: () =>
          new Promise((resolve) => {
            finishMigration = () => resolve('separate');
          }),
      },
    );
    await vi.waitFor(() => expect(finishMigration).toBeDefined());
    handlers.get('SIGINT')?.();
    await vi.waitFor(() => expect(exits).toEqual([0]));
    finishMigration?.();
    // Would reject (unreachable database) if it went on to createDeps and the startup checks.
    await expect(done).resolves.toBeUndefined();
  });
});
