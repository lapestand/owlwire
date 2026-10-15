import type { Command } from 'commander';
import type { ServerConfig } from '../config/load.js';
import { closeDeps, createDeps, type Deps } from '../deps.js';
import { createLogger } from '../logger.js';
import {
  AdminInputError,
  type BootstrapInstanceAdminResult,
  bootstrapInstanceAdmin,
  ConcurrentAdminUserError,
  normalizeAdminInput,
} from '../system/instance-admin.js';
import { migrateDatabase } from '../system/migrate.js';

export interface AdminCreateOptions {
  email: string;
  name?: string;
  passwordStdin?: boolean;
}

export interface AdminCreateIo {
  /** Whether stdin is an interactive terminal, where reading would wait for EOF and echo what is typed. */
  stdinIsTty(): boolean;
  /** The password from stdin, without its trailing newline (readPassword). */
  readStdin(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
  withDeps<T>(fn: (deps: Deps) => Promise<T>): Promise<T>;
}

const TRAILING_NEWLINE = /\r?\n$/;

/** The whole stream as UTF-8, without one trailing newline (the one `echo` or a here-string adds). */
export async function readPassword(stream: AsyncIterable<string | Buffer>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(TRAILING_NEWLINE, '');
}

export function formatAdminCreateResult(email: string, r: BootstrapInstanceAdminResult): string {
  if (!r.created) return `Existing user ${email} is now an instance admin.`;
  const lines = [`Instance admin ${email} created (id ${r.userId}).`];
  if (r.generatedPassword) {
    lines.push(
      `Generated password (shown once): ${r.generatedPassword}`,
      'Change it after the first sign-in.',
    );
  }
  return lines.join('\n');
}

/**
 * Exit codes: 0 done, 2 invalid input (also a terminal as stdin for --password-stdin) or a user created concurrently
 * with the same email. The input is checked before any database access, so a typo never migrates or connects. The
 * password read from stdin is never printed.
 */
export async function runAdminCreate(opts: AdminCreateOptions, io: AdminCreateIo): Promise<number> {
  if (opts.passwordStdin && io.stdinIsTty()) {
    io.err(
      '--password-stdin reads a password from a pipe, not a terminal; pipe the password, for example: ' +
        `printf '%s' "$PASSWORD" | owlwire admin create --email <email> --password-stdin`,
    );
    return 2;
  }
  try {
    const password = opts.passwordStdin ? await io.readStdin() : undefined;
    const input = normalizeAdminInput({
      email: opts.email,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(password !== undefined ? { password } : {}),
    });
    const result = await io.withDeps((deps) => bootstrapInstanceAdmin(deps, input));
    if (result.passwordIgnored) {
      io.err(`Warning: ${input.email} already exists; the password from stdin was ignored.`);
    }
    io.out(formatAdminCreateResult(input.email, result));
    return 0;
  } catch (err) {
    if (err instanceof AdminInputError || err instanceof ConcurrentAdminUserError) {
      io.err(err.message);
      return 2;
    }
    throw err;
  }
}

export function registerAdminCommands(
  program: Command,
  loadServerConfig: () => ServerConfig,
): void {
  const admin = program.command('admin').description('instance administration');
  admin
    .command('create')
    .description(
      'create an instance admin, or promote an existing user (migrates the database first)',
    )
    .requiredOption('--email <email>', 'admin email address')
    .option('--name <name>', 'display name (default: the local part of the email)')
    .option(
      '--password-stdin',
      'read the initial password from stdin (otherwise one is generated and printed once)',
    )
    .action(async (opts: AdminCreateOptions) => {
      process.exitCode = await runAdminCreate(opts, {
        stdinIsTty: () => process.stdin.isTTY === true,
        readStdin: () => readPassword(process.stdin),
        out: (line) => void process.stdout.write(`${line}\n`),
        err: (line) => void process.stderr.write(`${line}\n`),
        withDeps: async (fn) => {
          const config = loadServerConfig();
          const logger = createLogger(config.logLevel);
          await migrateDatabase(config, logger);
          const deps = createDeps(config, { logger });
          try {
            return await fn(deps);
          } finally {
            await closeDeps(deps);
          }
        },
      });
    });
}
