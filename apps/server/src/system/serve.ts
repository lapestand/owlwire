import { type ServerType, serve } from '@hono/node-server';
import type { Logger } from 'pino';
import type { Role, ServerConfig } from '../config/load.js';
import { closeDeps, createDeps, type Deps } from '../deps.js';
import { createApp } from '../http/app.js';
import { startWorker } from '../worker/runner.js';
import { upgradeLegacySecrets } from './legacy-secrets.js';
import { migrateDatabase } from './migrate.js';
import { createShutdown } from './shutdown.js';
import { assertLegacySecretsCovered, runStartupChecks } from './startup-checks.js';

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
 * createDeps -> runStartupChecks -> upgradeLegacySecrets first. A bind error (EADDRINUSE)
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
    const app = createApp({ ...deps, webDir: opts.webDir });
    const started = await new Promise<{ server: ServerType; port: number }>((resolve, reject) => {
      const server = serve({ fetch: app.fetch, port: opts.port }, (info) => {
        server.off('error', reject);
        resolve({ server, port: info.port });
      });
      // A bind error (EADDRINUSE etc.) rejects; an unlistened 'error' would crash the process.
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
  /** Test seams; default to the real steps. */
  migrate?: typeof migrateDatabase;
  startupChecks?: typeof runStartupChecks;
  upgrade?: typeof upgradeLegacySecrets;
  start?: typeof startServer;
  /** Defaults to process.env.NODE_ENV; OWLWIRE_ALLOW_INSECURE_DB_ROLE is ignored when it is 'production'. */
  nodeEnv?: string | undefined;
}

/**
 * `owlwire serve`: signal handlers are registered BEFORE migrating. Order: migrateDatabase ->
 * createDeps -> runStartupChecks -> upgradeLegacySecrets (refuses to start when a legacy secret's KEK version is not
 * configured) -> startServer. Shutdown is createShutdown (25 s limit,
 * exit 1 when the worker crashes) and calls `exit` exactly once.
 *
 * A signal during the migration shuts down at once (nothing is open yet; the migration transaction rolls back with
 * its connection when the process exits). A signal during a later step waits for that step to settle, then stops any
 * server it started and closes deps; an error the step raises after the signal (e.g. "pool ended") is ignored and no
 * further step runs.
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
  /** The in-flight step after createDeps; stop() waits for it before closing what it uses. */
  let inflight: Promise<unknown> = Promise.resolve();
  const step = <T>(p: Promise<T>): Promise<T> => {
    inflight = p.catch(() => undefined);
    return p;
  };
  const { shutdown, workerCrashed } = createShutdown({
    stop: async () => {
      stopping = true;
      await inflight;
      await running?.stop();
      if (deps) await closeDeps(deps);
    },
    logger,
    exit: hooks.exit,
  });
  hooks.onSignal('SIGINT', () => void shutdown('SIGINT'));
  hooks.onSignal('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await (hooks.migrate ?? migrateDatabase)(config, logger);
    if (stopping) return;
    const created = createDeps(config, { logger });
    deps = created;
    await step(
      (hooks.startupChecks ?? runStartupChecks)(created.db, created.authDb, {
        allowInsecureDbRole: config.allowInsecureDbRole,
        nodeEnv: 'nodeEnv' in hooks ? hooks.nodeEnv : process.env.NODE_ENV,
        logger,
      }),
    );
    if (stopping) return;
    const legacy = await step(
      (hooks.upgrade ?? upgradeLegacySecrets)(created.db, created.keyring, created.logger),
    );
    if (stopping) return;
    assertLegacySecretsCovered(legacy);
    await step(
      (hooks.start ?? startServer)(created, config.role, { port: config.port, webDir }).then(
        (r) => {
          // Set inside the step so a stop() waiting on it sees the server and stops it.
          running = r;
        },
      ),
    );
  } catch (err) {
    // After a signal, failures of the interrupted step are expected; shutdown owns the exit code.
    if (stopping) return;
    throw err;
  }
  if (stopping) return;
  (running as RunningServer | null)?.worker?.catch(workerCrashed);
}
