import { scrubQueryParams } from '@owlwire/core';
import { describe, expect, it } from 'vitest';
import { createLogger, REDACT_PATHS, safeErrorText, toAdapterLogger } from './logger.js';

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

  it('scrubQueryParams cuts from the first params marker to the end of the text', () => {
    const text =
      "with error 'Failed query: select $1\nparams: SECRET':\n  Error: Failed query: select $1\n  params: SECRET\n      at run (file.js:1:1)";
    const out = scrubQueryParams(text);
    expect(out).toBe("with error 'Failed query: select $1\nparams: [redacted]");
    expect(scrubQueryParams('no params here')).toBe('no params here');
  });

  it('redacts multi-line params whose lines start with "at" and keeps the real stack frames (review I-1)', () => {
    const { lines, stream } = capture();
    const err = queryError([
      'Standup\nat 10:00, password is SECRET-STANDUP',
      'body\n    at fake (frame.js:1:1) SECRET-FRAME',
      'v1:wrapped-dek-SECRET-DEK',
    ]);
    createLogger('info', stream).error({ err }, 'boom');
    expect(lines[0]).not.toMatch(/SECRET-(STANDUP|FRAME|DEK)/);
    const out = JSON.parse(lines[0] ?? '{}').err;
    expect(out.message).toBe(
      'Failed query: update connections set config_enc = $1 where id = $2\nparams: [redacted]',
    );
    expect(out.stack.startsWith(`DrizzleQueryError: ${out.message}\n    at `)).toBe(true);
    expect(out.stack).toContain('logger.test.ts');
  });

  it('sanitizes errors and query strings under any key, nested, as own fields and as non-Error causes', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.error({ e: queryError(['SECRET-CUSTOM-KEY']) }, 'custom key');
    log.error({ ctx: { job: { failure: queryError(['SECRET-NESTED']) } } }, 'nested');
    log.error({
      err: Object.assign(new Error('wrapper'), { original: queryError(['SECRET-OWN']) }),
    });
    log.error({
      err: new Error('plain cause', { cause: { params: ['SECRET-PLAIN-CAUSE'], code: 'X' } }),
    });
    log.error({
      err: { message: 'not an error', params: ['SECRET-PLAIN-ERR'], hint: 'SECRET-HINT' },
    });
    log.error({ reason: 'Failed query: select $1\nparams: SECRET-STRING' }, 'string');
    const circular: Record<string, unknown> = { name: 'loop' };
    circular.self = circular;
    log.info({ circular }, 'cycle');
    expect(lines).toHaveLength(7);
    expect(lines.join('\n')).not.toContain('SECRET-');
    const [custom, nested, own, plainCause, , str, cycle] = lines.map((l) => JSON.parse(l));
    expect(custom.e).toMatchObject({ type: 'DrizzleQueryError' });
    expect(nested.ctx.job.failure.message).toContain('params: [redacted]');
    expect(own.err.original.message).toContain('params: [redacted]');
    expect(plainCause.err.cause).toEqual({ code: 'X' });
    expect(str.reason).toBe('Failed query: select $1\nparams: [redacted]');
    expect(cycle.circular).toEqual({ name: 'loop', self: '[Circular]' });
  });

  it('sanitizes errors and strings interpolated with %s', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.error('failed: %s', queryError(['SECRET-INTERP']));
    log.error('failed: %s', 'Failed query: select $1\nparams: SECRET-INTERP-STR');
    log.error({ jobId: '1' }, 'failed: %s', queryError(['SECRET-INTERP-OBJ']));
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toContain('SECRET-');
    expect(JSON.parse(lines[0] ?? '{}').msg).toContain('failed: DrizzleQueryError: Failed query');
  });

  it('drops pg error fields that carry row values and masks values echoed by data exceptions', () => {
    const { lines, stream } = capture();
    const pgErr = Object.assign(new Error('invalid input syntax for type uuid: "SECRET-ECHO"'), {
      code: '22P02',
      severity: 'ERROR',
      detail: 'Failing row contains (SECRET-DETAIL).',
      where: 'SQL statement "insert into x values (\'SECRET-WHERE\')"',
      internalQuery: "select 'SECRET-INTERNAL'",
      hint: 'SECRET-HINT',
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
    expect(cause.hint).toBeUndefined();
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

describe('safeErrorText (CLI fatal path)', () => {
  it('never prints query params, even lines starting with "at", along the whole cause chain', () => {
    const inner = queryError(['inner\n    at leak (x.js:1:1) SECRET-INNER']);
    const err = queryError(
      ['Standup\nat 10:00 SECRET-STANDUP', 'body\n    at fake (frame.js:1:1) SECRET-FRAME'],
      inner,
    );
    const text = safeErrorText(err);
    expect(text).not.toMatch(/SECRET-(INNER|STANDUP|FRAME)/);
    expect(text).not.toContain('frame.js');
    const lines = text.split('\n');
    expect(lines[0]).toBe(
      'DrizzleQueryError: Failed query: update connections set config_enc = $1 where id = $2',
    );
    expect(
      lines.filter((l) => l.startsWith('caused by: DrizzleQueryError: Failed query')),
    ).toHaveLength(1);
    expect(lines.filter((l) => /^\s+at /.test(l)).length).toBeGreaterThan(1);
    expect(text).toContain('logger.test.ts');
  });

  it('withholds echoed input and handles non-errors and cycles', () => {
    const data = Object.assign(new Error('invalid input syntax for type uuid: "SECRET-ID"'), {
      code: '22P02',
    });
    expect(safeErrorText(data)).not.toContain('SECRET-ID');
    expect(safeErrorText('SECRET-STRING')).toBe('unknown error');
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    Object.assign(a, { cause: b });
    expect(
      safeErrorText(a)
        .split('\n')
        .filter((l) => !/^\s+at /.test(l)),
    ).toEqual(['Error: a', 'caused by: Error: b']);
  });
});
