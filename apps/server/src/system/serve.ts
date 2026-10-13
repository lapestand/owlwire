import { type ServerType, serve } from '@hono/node-server';
import type { Role } from '../config/load.js';
import type { Deps } from '../deps.js';
import { createApp } from '../http/app.js';
import { startWorker } from '../worker/runner.js';
import { migrateDatabase } from './migrate.js';

export interface RunningServer {
  port: number | null;
  /** graphile-worker's runner promise (null without a worker); it rejects if the worker crashes. */
  worker: Promise<void> | null;
  stop(): Promise<void>;
}

function closeServer(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

/**
 * P0 order: createDeps (main.ts) -> migrateDatabase -> HTTP/worker.
 * P1a changes it to migrateDatabase -> createDeps -> runStartupChecks (contract §11.2, R97).
 */
export async function startServer(
  deps: Deps,
  role: Role,
  opts: { port: number; webDir: string | null },
): Promise<RunningServer> {
  await migrateDatabase(deps.pool);
  const stops: Array<() => Promise<void>> = [];
  let port: number | null = null;
  let worker: Promise<void> | null = null;

  if (role === 'all' || role === 'api') {
    const app = createApp({
      db: deps.db,
      clock: deps.clock,
      logger: deps.logger,
      config: deps.config,
      webDir: opts.webDir,
    });
    const started = await new Promise<{ server: ServerType; port: number }>((resolve) => {
      const server = serve({ fetch: app.fetch, port: opts.port }, (info) =>
        resolve({ server, port: info.port }),
      );
    });
    port = started.port;
    stops.push(() => closeServer(started.server));
  }

  if (role === 'all' || role === 'worker') {
    const runner = await startWorker(deps);
    worker = runner.promise;
    stops.push(() => runner.stop());
  }

  deps.logger.info({ role, port, webUi: opts.webDir !== null }, 'owlwire started');
  return {
    port,
    worker,
    stop: async () => {
      for (const stop of stops) await stop();
    },
  };
}
