import { describe, expect, it } from 'vitest';
import { createLogger } from '../logger.js';
import { betterAuthLogger, redactAuthText } from './auth-logger.js';

function capture() {
  const lines: string[] = [];
  const logger = createLogger('debug', { write: (line: string) => void lines.push(line) });
  return { lines, bridge: betterAuthLogger(logger) };
}

describe('redactAuthText', () => {
  it('replaces URLs (which can carry tokens) and email addresses', () => {
    expect(
      redactAuthText(
        'Invalid callbackURL: https://evil.example/reset-password/abc?token=xyz for ali@example.com',
      ),
    ).toBe('Invalid callbackURL: [url] for [email]');
  });
});

describe('betterAuthLogger', () => {
  it('logs warnings and errors through pino under component auth', () => {
    const { lines, bridge } = capture();
    bridge.log('error', 'Invalid redirectURL: https://evil.example/?token=t0k3n');
    bridge.log('warn', 'User not found');
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(parsed).toMatchObject([
      { level: 50, component: 'auth', msg: 'Invalid redirectURL: [url]' },
      { level: 40, component: 'auth', msg: 'User not found' },
    ]);
    expect(lines.join('')).not.toContain('t0k3n');
  });

  it('drops info and debug messages, which can name the user', () => {
    const { lines, bridge } = capture();
    bridge.log('info', 'Sign-up attempt for existing email: ali@example.com');
    bridge.log('debug', 'anything');
    expect(lines).toEqual([]);
  });

  it('puts errors under err, where the serializer cuts query parameters, and redacts other arguments', () => {
    const { lines, bridge } = capture();
    const failed = new Error(
      'Failed query: insert into "auth_user" ("email") values ($1)\nparams: ali@example.com',
    );
    bridge.log('error', 'Failed to create user', failed, { email: 'ali@example.com', n: 1 });
    const out = lines.join('');
    expect(out).not.toContain('ali@example.com');
    const parsed = JSON.parse(lines[0] ?? '{}') as {
      err: { message: string };
      details: Array<Record<string, unknown>>;
    };
    expect(parsed.err.message).toMatch(/^Failed query: insert into "auth_user"/);
    expect(parsed.details).toEqual([{ email: '[email]', n: 1 }]);
  });
});
