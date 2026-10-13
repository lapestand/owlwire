import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { ConfigError, loadConfig, ROLES, type Role } from './config/load.js';
import { createDeps, type Deps } from './deps.js';
import { formatSeedResult, seedDevWorkspace } from './system/dev-seed.js';
import { migrateDatabase } from './system/migrate.js';
import { startServer } from './system/serve.js';
import { createShutdown } from './system/shutdown.js';

// src/main.ts and dist/main.js both sit one level below apps/server, so ../public is the built UI.
const webDirCandidate = fileURLToPath(new URL('../public', import.meta.url));

function readTextFileOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function boot(roleOverride?: Role): Deps {
  const config = loadConfig(process.env, readTextFileOrNull);
  return createDeps(roleOverride ? { ...config, role: roleOverride } : config);
}

const program = new Command()
  .name('owlwire')
  .description('Owlwire notification router')
  .showHelpAfterError();

program
  .command('serve')
  .description('run the HTTP API and/or the worker (migrates the database first)')
  .addOption(new Option('--role <role>', 'process role').choices([...ROLES]))
  .action(async (opts: { role?: Role }) => {
    const deps = boot(opts.role);
    const running = await startServer(deps, deps.config.role, {
      port: deps.config.port,
      webDir: existsSync(webDirCandidate) ? webDirCandidate : null,
    });
    const { shutdown, workerCrashed } = createShutdown({
      stop: async () => {
        await running.stop();
        await deps.pool.end();
      },
      logger: deps.logger,
      exit: (code) => process.exit(code),
    });
    running.worker?.catch(workerCrashed);
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  });

program
  .command('migrate')
  .description('apply database migrations and exit')
  .action(async () => {
    const deps = boot();
    await migrateDatabase(deps.pool);
    deps.logger.info('migrations applied');
    await deps.pool.end();
  });

program
  .command('dev:seed')
  .description('P0 only: create a workspace, app, installation, connection, destination and rule')
  .addOption(
    new Option('--platform <platform>', 'target platform')
      .choices(['telegram', 'webhook'])
      .default('telegram'),
  )
  .option('--bot-token <token>', 'telegram bot token (platform telegram)')
  .option('--chat-id <id>', 'telegram chat id, or any label for the fake webhook adapter')
  .option('--thread-id <id>', 'telegram forum topic id')
  .option('--name <name>', 'workspace name', 'Dev')
  .action(
    async (opts: {
      platform: 'telegram' | 'webhook';
      botToken?: string;
      chatId?: string;
      threadId?: string;
      name: string;
    }) => {
      const deps = boot();
      try {
        await migrateDatabase(deps.pool);
        const result = await seedDevWorkspace(deps.db, deps.crypto, deps.clock, {
          platform: opts.platform,
          chatId: opts.chatId ?? (opts.platform === 'webhook' ? 'fake-destination' : ''),
          ...(opts.botToken ? { botToken: opts.botToken } : {}),
          ...(opts.threadId ? { threadId: opts.threadId } : {}),
          name: opts.name,
        });
        process.stdout.write(
          formatSeedResult(result, { port: deps.config.port, platform: opts.platform }),
        );
      } finally {
        await deps.pool.end();
      }
    },
  );

program.parseAsync(process.argv).catch((err: unknown) => {
  if (err instanceof ConfigError) {
    process.stderr.write(`configuration error: ${err.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
