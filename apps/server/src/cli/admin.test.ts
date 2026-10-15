import { Readable } from 'node:stream';
import { Command, CommanderError } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type BootstrapInstanceAdminResult,
  ConcurrentAdminUserError,
} from '../system/instance-admin.js';
import {
  type AdminCreateIo,
  formatAdminCreateResult,
  readPassword,
  registerAdminCommands,
  runAdminCreate,
} from './admin.js';

function fakeIo(
  opts: { stdin?: string; tty?: boolean; result?: BootstrapInstanceAdminResult; fail?: Error } = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  let depsUsed = false;
  let stdinRead = false;
  const io: AdminCreateIo = {
    stdinIsTty: () => opts.tty ?? false,
    readStdin: async () => {
      stdinRead = true;
      return opts.stdin ?? '';
    },
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    withDeps: async <T>() => {
      depsUsed = true;
      if (opts.fail) throw opts.fail;
      return (opts.result ?? {
        userId: 'u1',
        created: true,
        generatedPassword: 'gen-pass',
        passwordIgnored: false,
        emailVerified: true,
      }) as T;
    },
  };
  return { io, out, err, depsUsed: () => depsUsed, stdinRead: () => stdinRead };
}

describe('admin cli helpers', () => {
  it('prints the generated password once', () => {
    const out = formatAdminCreateResult('root@x.test', {
      userId: 'u1',
      created: true,
      generatedPassword: 'gen-pass',
      passwordIgnored: false,
      emailVerified: true,
    });
    expect(out).toContain('root@x.test');
    expect(out.split('gen-pass')).toHaveLength(2);
  });

  it('does not print a password for promotions or provided passwords', () => {
    expect(
      formatAdminCreateResult('a@x.test', {
        userId: 'u1',
        created: false,
        generatedPassword: null,
        passwordIgnored: false,
        emailVerified: true,
      }),
    ).toBe('Existing user a@x.test is now an instance admin.');
    expect(
      formatAdminCreateResult('a@x.test', {
        userId: 'u1',
        created: true,
        generatedPassword: null,
        passwordIgnored: false,
        emailVerified: true,
      }),
    ).not.toContain('password');
  });

  it('reads the password from stdin and trims the newline', async () => {
    expect(await readPassword(Readable.from(['secret-pass', 'word\n']))).toBe('secret-password');
    expect(await readPassword(Readable.from([Buffer.from('crlf-password\r\n')]))).toBe(
      'crlf-password',
    );
    // Exactly one newline goes: a password that itself ends in a newline keeps it.
    expect(await readPassword(Readable.from(['two-newlines\n\n']))).toBe('two-newlines\n');
  });
});

describe('runAdminCreate', () => {
  it('exits 2 on an invalid email without touching the database', async () => {
    const f = fakeIo();
    expect(await runAdminCreate({ email: 'nope' }, f.io)).toBe(2);
    expect(f.err.join('\n')).toMatch(/invalid email/);
    expect(f.depsUsed()).toBe(false);
  });

  it('exits 2 on a short password from stdin without echoing it', async () => {
    const f = fakeIo({ stdin: 'short\n' });
    expect(await runAdminCreate({ email: 'root@x.test', passwordStdin: true }, f.io)).toBe(2);
    expect(f.depsUsed()).toBe(false);
    expect([...f.out, ...f.err].join('\n')).not.toContain('short\n');
    expect(f.err.join('\n')).toMatch(/at least 10 characters/);
  });

  it('exits 2 on a stdin password longer than the sign-in library accepts', async () => {
    const f = fakeIo({ stdin: 'x'.repeat(129) });
    expect(await runAdminCreate({ email: 'root@x.test', passwordStdin: true }, f.io)).toBe(2);
    expect(f.depsUsed()).toBe(false);
    expect(f.err.join('\n')).toMatch(/at most 128 characters/);
    expect(f.err.join('\n')).not.toContain('xxxx');
  });

  it('passes the stdin password on as read, without stripping another newline', async () => {
    // readPassword already removed the one trailing newline; nine characters plus a newline are ten.
    const f = fakeIo({ stdin: 'nine-char\n' });
    expect(await runAdminCreate({ email: 'root@x.test', passwordStdin: true }, f.io)).toBe(0);
    expect(f.depsUsed()).toBe(true);
  });

  it('refuses --password-stdin on a terminal instead of waiting for input', async () => {
    const f = fakeIo({ tty: true });
    expect(await runAdminCreate({ email: 'root@x.test', passwordStdin: true }, f.io)).toBe(2);
    expect(f.err.join('\n')).toMatch(/pipe the password/);
    expect(f.stdinRead()).toBe(false);
    expect(f.depsUsed()).toBe(false);
    // Without the flag a terminal is fine: nothing is read from it.
    expect(await runAdminCreate({ email: 'root@x.test' }, fakeIo({ tty: true }).io)).toBe(0);
  });

  it('exits 2 when a concurrent sign-up took the email, and names the promote path instead of a retry', async () => {
    const f = fakeIo({ fail: new ConcurrentAdminUserError('root@x.test') });
    expect(await runAdminCreate({ email: 'root@x.test' }, f.io)).toBe(2);
    expect(f.out).toEqual([]);
    const text = f.err.join('\n');
    expect(text).toContain('an account with the email root@x.test already exists');
    expect(text).toContain('was not created by this command; nothing was changed');
    expect(text).toContain('`owlwire admin create --email root@x.test`');
    expect(text).toMatch(/checked that it is yours/);
    expect(text).not.toMatch(/run the command again/);
  });

  it('warns when the promoted existing account has an unverified email', async () => {
    const promoted = (emailVerified: boolean) =>
      fakeIo({
        result: {
          userId: 'u1',
          created: false,
          generatedPassword: null,
          passwordIgnored: false,
          emailVerified,
        },
      });
    const unverified = promoted(false);
    expect(await runAdminCreate({ email: 'root@x.test' }, unverified.io)).toBe(0);
    expect(unverified.out).toEqual(['Existing user root@x.test is now an instance admin.']);
    expect(unverified.err.join('\n')).toMatch(
      /unverified email.*\n?.*Check that the account is yours/s,
    );
    const verified = promoted(true);
    expect(await runAdminCreate({ email: 'root@x.test' }, verified.io)).toBe(0);
    expect(verified.err).toEqual([]);
  });

  it('exits 0 and prints the result', async () => {
    const f = fakeIo();
    expect(await runAdminCreate({ email: 'Root@X.test' }, f.io)).toBe(0);
    expect(f.out.join('\n')).toContain('Instance admin root@x.test created');
  });

  it('warns when the stdin password was ignored for an existing user', async () => {
    const f = fakeIo({
      stdin: 'a-very-long-password\n',
      result: {
        userId: 'u1',
        created: false,
        generatedPassword: null,
        passwordIgnored: true,
        emailVerified: true,
      },
    });
    expect(await runAdminCreate({ email: 'root@x.test', passwordStdin: true }, f.io)).toBe(0);
    expect(f.err.join('\n')).toContain('password from stdin was ignored');
    expect([...f.out, ...f.err].join('\n')).not.toContain('a-very-long-password');
  });
});

describe('owlwire admin create argument errors', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  /** Parses `owlwire admin create <args>`; returns the exit code commander asks for and what it printed. */
  async function parse(args: string[]): Promise<{ code: number | undefined; output: string }> {
    const written: string[] = [];
    const program = new Command().name('owlwire').exitOverride();
    program.configureOutput({
      writeOut: (s) => void written.push(s),
      writeErr: (s) => void written.push(s),
    });
    registerAdminCommands(program, () => {
      throw new Error('the database must not be touched');
    });
    try {
      await program.parseAsync(['node', 'owlwire', 'admin', 'create', ...args]);
      return {
        code: process.exitCode === undefined ? undefined : Number(process.exitCode),
        output: written.join(''),
      };
    } catch (err) {
      if (!(err instanceof CommanderError)) throw err;
      return { code: err.exitCode, output: written.join('') };
    }
  }

  it('exits 2 without --email', async () => {
    const r = await parse([]);
    expect(r.code).toBe(2);
    expect(r.output).toContain('--email');
  });

  it('exits 2 when --email has no value', async () => {
    expect((await parse(['--email'])).code).toBe(2);
  });

  it('exits 2 on an empty --email', async () => {
    expect((await parse(['--email', ''])).code).toBe(2);
  });

  it('exits 2 on an unknown option', async () => {
    expect((await parse(['--email', 'a@example.com', '--admin'])).code).toBe(2);
  });

  it('exits 0 for --help', async () => {
    const r = await parse(['--help']);
    expect(r.code).toBe(0);
    expect(r.output).toContain('--password-stdin');
  });
});
