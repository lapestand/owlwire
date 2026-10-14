import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createLogger, safeErrorText, serializeErr, toAdapterLogger } from './logger.js';

/** A secret that cannot occur by chance in the generated surrounding text (which never contains `~`). */
const secret = fc
  .string({
    unit: fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789:_-'),
    minLength: 6,
    maxLength: 24,
  })
  .map((s) => `~${s}~`);

const plain = fc.string({ unit: 'binary', maxLength: 40 }).map((s) => s.replaceAll('~', ''));

const frameLine = fc
  .tuple(fc.constantFrom('    at ', 'at ', '\tat ', '  at '), plain)
  .map(([prefix, rest]) => prefix + rest);

/** A parameter value carrying the secret, possibly over several lines that look like stack frames. */
const secretParam = fc
  .tuple(secret, fc.array(fc.oneof(plain, frameLine), { maxLength: 3 }), fc.nat())
  .map(([s, lines, at]) => {
    const all = [...lines];
    all.splice(at % (all.length + 1), 0, s);
    return { s, value: all.join('\n') };
  });

class DrizzleQueryError extends Error {
  constructor(
    readonly query: string,
    readonly params: unknown[],
    cause?: unknown,
  ) {
    super(`Failed query: ${query}\nparams: ${params}`, { cause });
  }
}

/**
 * A DrizzleQueryError-shaped error with the secret among its params: either a subclass (stack header carries the
 * name) or a plain Error renamed after construction (drizzle-orm 0.45), optionally caused by a pg error that echoes
 * the secret, and optionally wrapped by the repositories.
 */
const leakyError = fc
  .record({
    param: secretParam,
    others: fc.array(plain, { maxLength: 3 }),
    position: fc.nat(),
    subclass: fc.boolean(),
    pgCause: fc.option(
      fc.record({
        code: fc.constantFrom('22P02', '22007', '22001', 'P0001'),
        quote: fc.constantFrom('"', "'"),
      }),
      { nil: undefined },
    ),
    wrappers: fc.nat({ max: 3 }),
  })
  .map(({ param, others, position, subclass, pgCause, wrappers }) => {
    const params: unknown[] = [...others];
    params.splice(position % (params.length + 1), 0, param.value);
    const query = 'update connections set config_enc = $1 where id = $2';
    const cause =
      pgCause === undefined
        ? undefined
        : Object.assign(
            new Error(`invalid input value: ${pgCause.quote}${param.s}${pgCause.quote}`),
            {
              code: pgCause.code,
              detail: `Failing row contains (${param.s}).`,
              where: `SQL statement "insert into x values ('${param.s}')"`,
              hint: param.s,
              internalQuery: `select '${param.s}'`,
            },
          );
    let err: Error;
    if (subclass) {
      err = new DrizzleQueryError(query, params, cause);
    } else {
      err = new Error(`Failed query: ${query}\nparams: ${params}`, { cause });
      err.name = 'DrizzleQueryError';
      Object.assign(err, { query, params });
    }
    for (let i = 0; i < wrappers; i++) {
      err = new Error(`repo call ${i} failed`, { cause: err });
    }
    return { s: param.s, err };
  });

function capture() {
  const lines: string[] = [];
  return { lines, stream: { write: (s: string) => void lines.push(s) } };
}

describe('server logger sanitiser properties', () => {
  it('never writes a secret query param, whichever way the error is logged', () => {
    fc.assert(
      fc.property(leakyError, ({ s, err }) => {
        const { lines, stream } = capture();
        const log = createLogger('debug', stream);
        log.error(err);
        log.error({ err });
        log.error({ err }, 'boom');
        log.warn({ error: err }, 'boom');
        log.info({ ctx: { job: { failure: err } } }, 'nested');
        log.error('failed: %s', err);
        log.error({ jobId: '1' }, 'failed: %s', err);
        log.error({ reason: err.message }, 'as text');
        toAdapterLogger(log).error({ err });
        expect(lines).toHaveLength(9);
        for (const line of lines) expect(line).not.toContain(s);
        expect(JSON.stringify(serializeErr(err))).not.toContain(s);
        expect(safeErrorText(err)).not.toContain(s);
      }),
    );
  });
});
