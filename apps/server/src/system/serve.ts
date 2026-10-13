import { type ServerType, serve } from '@hono/node-server';
import type { Logger } from 'pino';
import type { Role, ServerConfig } from '../config/load.js';
import { createDeps, type Deps } from '../deps.js';
import { createApp } from '../http/app.js';
import { startWorker } from '../worker/runner.js';
import { upgradeLegacySecrets } from './legacy-secrets.js';
import { migrateDatabase } from './migrate.js';
import { createShutdown } from './shutdown.js';
import { runStartupChecks } from './startup-checks.js';

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
 * Starts HTTP and/or the worker; it does not migrate. The caller (`runServeCommand`) runs migrateDatabase ->
 * createDeps -> runStartupChecks -> upgradeLegacySecrets first (contract §11.2, R97). A bind error (EADDRINUSE)
 * rejects the returned promise.
 */
export async function startServer(
  deps: Deps,
  role: Role,
  opts: { port: number; webDir: string | null },
): Promise<RunningServer> {
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
    const started = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
      const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
        server.off('error', reject);
        resolve({ server, port: info.port });
      });
      // P0 carry-over: a bind error (EADDRINUSE etc.) rejects; an unlistened 'error' would crash the process.
      server.once('error', reject);
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

export interface ServeCommandHooks {
  onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void): void;
  exit(code: number): void;
  /** Test seam; defaults to migrateDatabase. */
  migrate?: typeof migrateDatabase;
  /** Defaults to process.env.NODE_ENV; only 'development' lets serve start without enforced RLS (with a warning). */
  nodeEnv?: string | undefined;
}

/**
 * `owlwire serve` (contract §11.2, R97): signal handlers are registered BEFORE migrating; a SIGTERM during the
 * migration closes whatever is open so far and exits (the migration transaction rolls back with its connection).
 * Order: migrateDatabase -> createDeps -> runStartupChecks -> upgradeLegacySecrets -> startServer. Shutdown is P0's
 * createShutdown (25 s limit, exit 1 when the worker crashes).
 */
export async function runServeCommand(
  config: ServerConfig,
  logger: Logger,
  webDir: string | null,
  hooks: ServeCommandHooks,
): Promise<void> {
  let deps: Deps | null = null;
  let running: RunningServer | null = null;
  let stopping = false;
  const closeDeps = async (d: Deps) => {
    await d.db.close();
    await d.pool.end();
  };
  const { shutdown, workerCrashed } = createShutdown({
    stop: async () => {
      stopping = true;
      await running?.stop();
      if (deps) await closeDeps(deps);
    },
    logger,
    exit: hooks.exit,
  });
  hooks.onSignal('SIGINT', () => void shutdown('SIGINT'));
  hooks.onSignal('SIGTERM', () => void shutdown('SIGTERM'));

  await (hooks.migrate ?? migrateDatabase)(config, logger);
  if (stopping) return;
  const created = createDeps(config, { logger });
  deps = created;
  await runStartupChecks(created.db, {
    nodeEnv: 'nodeEnv' in hooks ? hooks.nodeEnv : process.env.NODE_ENV,
    logger,
  });
  await upgradeLegacySecrets(created.db, created.keyring, created.logger);
  if (stopping) return;
  const started = await startServer(created, config.role, { port: config.port, webDir });
  if (stopping) {
    // A signal arrived while the server was starting; the shutdown above did not see it.
    await started.stop();
    return;
  }
  running = started;
  running.worker?.catch(workerCrashed);
}
