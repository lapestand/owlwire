import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { BootstrapInstanceAdminResult } from '../system/instance-admin.js';
import {
  type AdminCreateIo,
  formatAdminCreateResult,
  readPassword,
  runAdminCreate,
} from './admin.js';

function fakeIo(opts: { stdin?: string; result?: BootstrapInstanceAdminResult } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  let depsUsed = false;
  const io: AdminCreateIo = {
    readStdin: async () => opts.stdin ?? '',
    out: (l) => void out.push(l),
    err: (l) => void err.push(l),
    withDeps: async <T>() => {
      depsUsed = true;
      return (opts.result ?? {
        userId: 'u1',
        created: true,
        generatedPassword: 'gen-pass',
        passwordIgnored: false,
      }) as T;
    },
  };
  return { io, out, err, depsUsed: () => depsUsed };
}

describe('admin cli helpers', () => {
  it('prints the generated password once', () => {
    const out = formatAdminCreateResult('root@x.test', {
      userId: 'u1',
      created: true,
      generatedPassword: 'gen-pass',
      passwordIgnored: false,
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
      }),
    ).toBe('Existing user a@x.test is now an instance admin.');
    expect(
      formatAdminCreateResult('a@x.test', {
        userId: 'u1',
        created: true,
        generatedPassword: null,
        passwordIgnored: false,
      }),
    ).not.toContain('password');
  });

  it('reads the password from stdin and trims the newline', async () => {
    expect(await readPassword(Readable.from(['secret-pass', 'word\n']))).toBe('secret-password');
    expect(await readPassword(Readable.from([Buffer.from('crlf-password\r\n')]))).toBe(
      'crlf-password',
    );
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

  it('exits 0 and prints the result', async () => {
    const f = fakeIo();
    expect(await runAdminCreate({ email: 'Root@X.test' }, f.io)).toBe(0);
    expect(f.out.join('\n')).toContain('Instance admin root@x.test created');
  });

  it('warns when the stdin password was ignored for an existing user', async () => {
    const f = fakeIo({
      stdin: 'a-very-long-password\n',
      result: { userId: 'u1', created: false, generatedPassword: null, passwordIgnored: true },
    });
    expect(await runAdminCreate({ email: 'root@x.test', passwordStdin: true }, f.io)).toBe(0);
    expect(f.err.join('\n')).toContain('password from stdin was ignored');
    expect([...f.out, ...f.err].join('\n')).not.toContain('a-very-long-password');
  });
});
