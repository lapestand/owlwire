import { Command } from 'commander';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getRegistrationSetting } from '../system/registration.js';
import { listWorkspacesForUser } from '../system/user-workspaces.js';
import { findUserByEmail } from '../system/users.js';
import { uniqueEmail } from '../test/auth-harness.js';
import { TEST_BASE_URL } from '../test/config.js';
import { createHarness, type Harness } from '../test/harness.js';
import { registerAdminCommands } from './admin.js';

/**
 * The real command on a server with the default auth hooks and no stored registration setting, so the edition
 * default (closed) applies: this is how a fresh install gets its first admin.
 */
describe('owlwire admin create (default hooks, closed default)', () => {
  let h: Harness;
  const savedExitCode = process.exitCode;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });
  afterEach(() => {
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
  });

  async function run(args: string[], stdin?: string): Promise<{ out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      err.push(String(chunk));
      return true;
    });
    if (stdin !== undefined) {
      vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(
        async function* (): AsyncGenerator<Buffer, undefined> {
          yield Buffer.from(stdin);
          return undefined;
        },
      );
    }
    const program = new Command().exitOverride();
    registerAdminCommands(program, () => h.deps.config);
    await program.parseAsync(['admin', 'create', ...args], { from: 'user' });
    return { out: out.join(''), err: err.join('') };
  }

  const signIn = (email: string, password: string) =>
    h.app.request(`${TEST_BASE_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { origin: TEST_BASE_URL, 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

  it('creates the first admin in closed mode and prints the generated password once', async () => {
    expect(await getRegistrationSetting(h.deps)).toEqual({ mode: 'closed', source: 'config' });
    const typed = uniqueEmail('Root');
    const email = typed.toLowerCase();
    const { out } = await run(['--email', typed]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).toContain(`Instance admin ${email} created`);
    const password = /Generated password \(shown once\): (\S+)/.exec(out)?.[1];
    expect(password).toBeDefined();
    const user = await findUserByEmail(h.deps, email);
    expect(user).toMatchObject({
      isInstanceAdmin: true,
      emailVerified: true,
      name: email.split('@')[0],
    });
    const personal = await listWorkspacesForUser(h.deps, user?.id ?? '');
    expect(personal).toMatchObject([{ kind: 'personal', role: 'owner' }]);
    expect((await signIn(email, password ?? '')).status).toBe(200);
    // The closed default still refuses everybody else.
    expect(await getRegistrationSetting(h.deps)).toEqual({ mode: 'closed', source: 'config' });
  });

  it('reads the password from stdin and promotes an existing user', async () => {
    const email = uniqueEmail('second');
    const { out } = await run(
      ['--email', email, '--name', 'Second', '--password-stdin'],
      'a-very-long-password\n',
    );
    expect(process.exitCode ?? 0).toBe(0);
    expect(out).not.toContain('password');
    expect((await signIn(email, 'a-very-long-password')).status).toBe(200);

    const again = await run(
      ['--email', email.toUpperCase(), '--password-stdin'],
      'ignored-password\n',
    );
    expect(again.out).toContain(`Existing user ${email} is now an instance admin.`);
    expect(again.err).toContain('password from stdin was ignored');
    expect((await signIn(email, 'a-very-long-password')).status).toBe(200);
  });

  it('strips only one trailing newline from the stdin password', async () => {
    const email = uniqueEmail('newline');
    await run(['--email', email, '--password-stdin'], 'ends-with-newline\n\n');
    expect(process.exitCode ?? 0).toBe(0);
    expect((await signIn(email, 'ends-with-newline')).status).toBe(401);
    expect((await signIn(email, 'ends-with-newline\n')).status).toBe(200);
  });

  it('exits 2 on an invalid email', async () => {
    const { err } = await run(['--email', 'not-an-email']);
    expect(process.exitCode).toBe(2);
    expect(err).toContain('invalid email: not-an-email');
  });
});
