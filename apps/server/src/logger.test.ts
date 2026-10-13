import { describe, expect, it } from 'vitest';
import { createLogger, toAdapterLogger } from './logger.js';

function capture() {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => void lines.push(s) } };
}

describe('createLogger', () => {
  it('redacts tokens, configs, passwords, secrets, cookies and authorization headers', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.info(
      {
        token: 'ow_inst_secret',
        authorization: 'Bearer x',
        secret: 's',
        botToken: '1:abc',
        cookie: 'owlwire.session=x',
        ctx: {
          token: 't',
          config: { botToken: 'b' },
          password: 'p',
          secret: 's',
          botToken: '2:def',
          cookie: 'c',
          keep: 'visible',
        },
      },
      'hello',
    );
    const out = JSON.parse(lines[0] ?? '{}');
    expect(out.msg).toBe('hello');
    expect(out.token).toBe('[redacted]');
    expect(out.authorization).toBe('[redacted]');
    expect(out.secret).toBe('[redacted]');
    expect(out.botToken).toBe('[redacted]');
    expect(out.cookie).toBe('[redacted]');
    expect(out.ctx).toEqual({
      token: '[redacted]',
      config: '[redacted]',
      password: '[redacted]',
      secret: '[redacted]',
      botToken: '[redacted]',
      cookie: '[redacted]',
      keep: 'visible',
    });
    expect(lines[0]).not.toContain('1:abc');
    expect(lines[0]).not.toContain('2:def');
  });

  it('respects the level', () => {
    const { lines, stream } = capture();
    createLogger('warn', stream).info('dropped');
    expect(lines).toHaveLength(0);
  });
});

describe('toAdapterLogger', () => {
  it('accepts a bare message or an object plus message', () => {
    const { lines, stream } = capture();
    const log = toAdapterLogger(createLogger('debug', stream));
    log.info('plain');
    log.warn({ connectionId: 'c1' }, 'with context');
    expect(JSON.parse(lines[0] ?? '{}').msg).toBe('plain');
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ connectionId: 'c1', msg: 'with context' });
  });
});
