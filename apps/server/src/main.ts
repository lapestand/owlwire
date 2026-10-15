import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { systemClock } from '@owlwire/core';
import { createKeyring } from '@owlwire/crypto';
import { openDatabase } from '@owlwire/db';
import { Command, CommanderError, Option } from 'commander';
import { registerAdminCommands } from './cli/admin.js';
import { addVersionOption, readPackageVersion } from './cli/version.js';
import { ConfigError, loadConfig, ROLES, type Role, type ServerConfig } from './config/load.js';
import { createLogger, safeErrorText } from './logger.js';
import { runKeysRotate } from './system/keys-rotate.js';
import { migrateDatabase } from './system/migrate.js';
import { runServeCommand } from './system/serve.js';

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

function readConfig(roleOverride?: Role): ServerConfig {
  const config = loadConfig(process.env, readTextFileOrNull);
  return roleOverride ? { ...config, role: roleOverride } : config;
}

const program = new Command()
  .name('owlwire')
  .description('Owlwire notification router')
  .showHelpAfterError();
// Like ../public above, ../package.json is the server package's own in both layouts (and in the image).
addVersionOption(program, readPackageVersion(new URL('../package.json', import.meta.url)));

program
  .command('serve')
  .description('run the HTTP API and/or the worker (migrates the database first)')
  .addOption(new Option('--role <role>', 'process role').choices([...ROLES]))
  .action(async (opts: { role?: Role }) => {
    const config = readConfig(opts.role);
    await runServeCommand(
      config,
      createLogger(config.logLevel),
      existsSync(webDirCandidate) ? webDirCandidate : null,
      {
        onSignal: (signal, handler) => {
          process.on(signal, handler);
        },
        exit: (code) => process.exit(code),
      },
    );
  });

program
  .command('migrate')
  .description('apply database migrations and exit')
  .action(async () => {
    const config = readConfig();
    const logger = createLogger(config.logLevel);
    await migrateDatabase(config, logger);
    logger.info('migrations applied');
  });

const keys = program.command('keys').description('manage encryption keys');
keys
  .command('rotate')
  .description(
    're-wrap all workspace data keys with OWLWIRE_KEK (requires OWLWIRE_KEK_PREVIOUS for older keys)',
  )
  .action(async () => {
    // Application role with system scope (OWLWIRE_DATABASE_URL); the migration role is not needed. Only the
    // keyring, a logger and the db handle are built: no adapters, SecretBox or worker pool (createDeps).
    const config = readConfig();
    const logger = createLogger(config.logLevel);
    const keyring = createKeyring(config.kek.current, config.kek.previous);
    const db = openDatabase({
      url: config.databaseUrl,
      keyring,
      clock: systemClock,
      onPoolError: (err) => logger.error({ err }, 'database client error'),
    });
    try {
      process.exitCode = await runKeysRotate({
        db,
        keyring,
        logger,
        out: (line) => process.stdout.write(`${line}\n`),
      });
    } finally {
      await db.close();
    }
  });

registerAdminCommands(program, () => readConfig());

program.parseAsync(process.argv).catch((err: unknown) => {
  // Raised only by commands with an exit override, after commander printed the usage error or the help.
  if (err instanceof CommanderError) process.exit(err.exitCode);
  if (err instanceof ConfigError) {
    process.stderr.write(`configuration error: ${err.message}\n`);
    process.exit(2);
  }
  // safeErrorText cuts DrizzleQueryError's "params:" (wrapped keys, ciphertext) and takes frames only from the
  // stack below the message header, for the whole cause chain.
  process.stderr.write(`${safeErrorText(err)}\n`);
  process.exit(1);
});
