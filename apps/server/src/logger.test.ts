import { describe, expect, it } from 'vitest';
import { createLogger, REDACT_PATHS, scrubQueryParams, toAdapterLogger } from './logger.js';

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

/** DrizzleQueryError biçimi (drizzle-orm 0.45 errors.js): mesaj params'ı gömer, params alanı da vardır. */
function queryError(params: unknown[], cause?: Error): Error {
  const query = 'update connections set config_enc = $1 where id = $2';
  const err = new Error(`Failed query: ${query}\nparams: ${params}`);
  err.name = 'DrizzleQueryError';
  return Object.assign(err, { query, params, cause });
}

describe('REDACT_PATHS', () => {
  it('is exactly the P0 list (dropping an entry fails this test)', () => {
    expect(REDACT_PATHS).toEqual([
      'token',
      'config',
      'password',
      'secret',
      'botToken',
      'cookie',
      'authorization',
      '*.token',
      '*.config',
      '*.password',
      '*.secret',
      '*.botToken',
      '*.cookie',
      '*.authorization',
    ]);
  });
});

describe('query parameter redaction (I-6)', () => {
  it('drops drizzle query params from err.message, err.stack and err.params, keeps the cause', () => {
    const { lines, stream } = capture();
    const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "x"'), {
      code: '23505',
    });
    createLogger('info', stream).error(
      { err: queryError(['123:SECRET-BOT-TOKEN', 'abc'], pgErr) },
      'boom',
    );
    expect(lines[0]).not.toContain('SECRET-BOT-TOKEN');
    const out = JSON.parse(lines[0] ?? '{}');
    expect(out.err).toMatchObject({
      type: 'DrizzleQueryError',
      message:
        'Failed query: update connections set config_enc = $1 where id = $2\nparams: [redacted]',
      query: 'update connections set config_enc = $1 where id = $2',
      cause: { code: '23505' },
    });
    expect(out.err.params).toBeUndefined();
    expect(out.err.stack).toContain('params: [redacted]');
  });

  it('scrubs a drizzle error wrapped as a cause and parameters that span lines', () => {
    const { lines, stream } = capture();
    const outer = new Error('route_event failed', {
      cause: queryError(['line1\nSECRET-LINE-2', 'x']),
    });
    createLogger('info', stream).error({ err: outer }, 'boom');
    expect(lines[0]).not.toContain('SECRET-LINE-2');
    expect(JSON.parse(lines[0] ?? '{}').err.message).toBe('route_event failed');
  });

  it('scrubs the msg pino derives from err.message when no message is given', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.error(queryError(['SECRET-FIRST-ARG']));
    log.error({ err: queryError(['SECRET-NO-MSG']) });
    toAdapterLogger(log).error({ err: queryError(['SECRET-ADAPTER']) });
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toMatch(/SECRET-(FIRST-ARG|NO-MSG|ADAPTER)/);
    expect(JSON.parse(lines[0] ?? '{}').msg).toContain('params: [redacted]');
  });

  it('serializes an error logged under `error` the same way', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.warn({ error: queryError(['SECRET-ERROR-KEY']) }, 'x');
    log.warn({ error: 'Failed query: select $1\nparams: SECRET-ERROR-TEXT' }, 'y');
    expect(lines.join('\n')).not.toMatch(/SECRET-ERROR-(KEY|TEXT)/);
    expect(JSON.parse(lines[0] ?? '{}').error).toMatchObject({ type: 'DrizzleQueryError' });
    expect(JSON.parse(lines[1] ?? '{}').error).toBe('Failed query: select $1\nparams: [redacted]');
  });

  it('scrubQueryParams cuts each params segment up to the next stack frame', () => {
    const text =
      "with error 'Failed query: select $1\nparams: SECRET':\n  Error: Failed query: select $1\n  params: SECRET\n      at run (file.js:1:1)";
    const out = scrubQueryParams(text);
    expect(out).not.toContain('SECRET');
    expect(out).toContain('at run (file.js:1:1)');
    expect(scrubQueryParams('no params here')).toBe('no params here');
  });

  it('drops pg error fields that carry row values and masks values echoed by data exceptions', () => {
    const { lines, stream } = capture();
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "SECRET-ECHO"'), {
      code: '22P02',
      severity: 'ERROR',
      detail: 'Failing row contains (SECRET-DETAIL).',
      where: 'SQL statement "insert into x values (\'SECRET-WHERE\')"',
      internalQuery: "select 'SECRET-INTERNAL'",
      routine: 'string_to_uuid',
    });
    createLogger('info', stream).error({ err: queryError(['SECRET-PARAM'], pgErr) }, 'boom');
    expect(lines[0]).not.toMatch(/SECRET-/);
    const cause = JSON.parse(lines[0] ?? '{}').err.cause;
    expect(cause).toMatchObject({ code: '22P02', routine: 'string_to_uuid' });
    expect(cause.message).toBe('invalid input syntax for type uuid: [redacted]');
    expect(cause.detail).toBeUndefined();
    expect(cause.where).toBeUndefined();
    expect(cause.internalQuery).toBeUndefined();
  });

  it('does not trust a SyntaxError message: JSON.parse echoes its input', () => {
    const { lines, stream } = capture();
    let parseError: unknown;
    try {
      JSON.parse('bot123:SECRET-JSON');
    } catch (err) {
      parseError = err;
    }
    expect(String(parseError)).toContain('SECRET-JSON');
    const log = createLogger('info', stream);
    log.error({ err: parseError }, 'config parse failed');
    log.error(parseError);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).not.toContain('SECRET-JSON');
    expect(JSON.parse(lines[0] ?? '{}').err).toMatchObject({ type: 'SyntaxError' });
    expect(JSON.parse(lines[0] ?? '{}').err.stack).toMatch(/\n\s+at /);
  });
});
