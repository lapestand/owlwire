/** Hard limit for a graceful stop; compose gives the container 40 s before SIGKILL. */
export const SHUTDOWN_DEADLINE_MS = 25_000;

interface ShutdownLogger {
  info(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
  fatal(obj: object, msg: string): void;
}

export interface ShutdownOptions {
  /** Stops HTTP and worker, then closes the pool. */
  stop: () => Promise<void>;
  logger: ShutdownLogger;
  exit: (code: number) => void;
  setTimer?: (fn: () => void, ms: number) => { unref?(): unknown };
  deadlineMs?: number;
}

export interface ShutdownHandle {
  /** Runs the graceful stop once; later calls (a second signal) are ignored. */
  shutdown(signal: string): Promise<void>;
  /** The worker's runner promise rejected: the process cannot do its job any more. */
  workerCrashed(err: unknown): void;
}

export function createShutdown(opts: ShutdownOptions): ShutdownHandle {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const deadlineMs = opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  let shuttingDown = false;

  return {
    async shutdown(signal) {
      if (shuttingDown) return;
      shuttingDown = true;
      opts.logger.info({ signal }, 'shutting down');
      setTimer(() => {
        opts.logger.error({ deadlineMs }, 'shutdown deadline exceeded');
        opts.exit(1);
      }, deadlineMs).unref?.();
      let code = 1;
      try {
        await opts.stop();
        code = 0;
      } catch (err) {
        opts.logger.error({ err }, 'shutdown failed');
      } finally {
        opts.exit(code);
      }
    },
    workerCrashed(err) {
      opts.logger.fatal({ err }, 'worker crashed');
      opts.exit(1);
    },
  };
}
