import { describe, expect, it, vi } from 'vitest';
import { createShutdown, SHUTDOWN_DEADLINE_MS } from './shutdown.js';

function setup(stop: () => Promise<void> = async () => {}) {
  const exit = vi.fn<(code: number) => void>();
  const logger = { info: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  const timers: Array<{ fn: () => void; ms: number; unref: ReturnType<typeof vi.fn> }> = [];
  const setTimer = (fn: () => void, ms: number) => {
    const t = { fn, ms, unref: vi.fn() };
    timers.push(t);
    return t;
  };
  const stopSpy = vi.fn(stop);
  const handle = createShutdown({ stop: stopSpy, logger, exit, setTimer });
  return { handle, exit, logger, timers, stop: stopSpy };
}

describe('createShutdown', () => {
  it('stops once and exits 0 even when SIGINT and SIGTERM both arrive', async () => {
    const { handle, exit, stop, logger } = setup();
    await Promise.all([handle.shutdown('SIGINT'), handle.shutdown('SIGTERM')]);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(logger.info).toHaveBeenCalledWith({ signal: 'SIGINT' }, 'shutting down');
  });

  it('logs the error and exits 1 when stopping fails', async () => {
    const err = new Error('pool end failed');
    const { handle, exit, logger } = setup(async () => {
      throw err;
    });
    await handle.shutdown('SIGTERM');
    expect(logger.error).toHaveBeenCalledWith({ err }, 'shutdown failed');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('arms an unref-ed hard deadline that exits 1 when stop hangs', async () => {
    const { handle, exit, logger, timers } = setup(() => new Promise<void>(() => {}));
    void handle.shutdown('SIGTERM');
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(SHUTDOWN_DEADLINE_MS);
    expect(timers[0]?.unref).toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    timers[0]?.fn();
    expect(logger.error).toHaveBeenCalledWith(
      { deadlineMs: SHUTDOWN_DEADLINE_MS },
      'shutdown deadline exceeded',
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('keeps the deadline well under the compose stop grace period', () => {
    expect(SHUTDOWN_DEADLINE_MS).toBe(25_000);
  });

  it('logs a fatal worker crash and exits 1', () => {
    const { handle, exit, logger } = setup();
    const err = new Error('worker died');
    handle.workerCrashed(err);
    expect(logger.fatal).toHaveBeenCalledWith({ err }, 'worker crashed');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
