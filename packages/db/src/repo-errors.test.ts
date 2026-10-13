import { describe, expect, it } from 'vitest';
import {
  mapPgErrors,
  pgErrorCode,
  pgErrorOf,
  RepoConflictError,
  RepoNotFoundError,
  safeErrorMessage,
} from './errors.js';

const pgErr = (code: string, constraint?: string) =>
  Object.assign(new Error('pg'), { code, constraint });

describe('pgErrorOf', () => {
  it('reads code from the error or its cause', () => {
    expect(pgErrorOf(pgErr('23505', 'x_uq'))).toEqual({ code: '23505', constraint: 'x_uq' });
    expect(pgErrorOf(Object.assign(new Error('wrapped'), { cause: pgErr('23503') }))).toEqual({
      code: '23503',
      constraint: undefined,
    });
    expect(pgErrorOf(new Error('plain'))).toBeNull();
  });
});

describe('safeErrorMessage', () => {
  it('drops drizzle query parameters and keeps the error name', () => {
    const err = Object.assign(
      new Error('Failed query: update workspace_keys set wrapped_dek = $1\nparams: \\x0102,secret'),
      {
        name: 'DrizzleQueryError',
      },
    );
    expect(safeErrorMessage(err)).toBe(
      'DrizzleQueryError: Failed query: update workspace_keys set wrapped_dek = $1',
    );
    expect(safeErrorMessage(new Error('plain'))).toBe('Error: plain');
    expect(safeErrorMessage('x')).toBe('unknown error');
  });
});

describe('mapPgErrors', () => {
  it('maps unique violations to RepoConflictError', async () => {
    await expect(
      mapPgErrors('audience', 'id1', () =>
        Promise.reject(pgErr('23505', 'audiences_workspace_name_uq')),
      ),
    ).rejects.toBeInstanceOf(RepoConflictError);
  });

  it('maps foreign key violations to RepoNotFoundError by default', async () => {
    await expect(
      mapPgErrors('destination', 'id1', () => Promise.reject(pgErr('23503'))),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('maps foreign key violations to RepoConflictError when asked (delete in use)', async () => {
    await expect(
      mapPgErrors('audience', 'id1', () => Promise.reject(pgErr('23503')), {
        fkViolation: 'conflict',
      }),
    ).rejects.toBeInstanceOf(RepoConflictError);
  });

  it('rethrows other errors untouched', async () => {
    const e = new Error('boom');
    await expect(mapPgErrors('x', 'y', () => Promise.reject(e))).rejects.toBe(e);
  });
});

describe('cause chain walk', () => {
  const nest = (inner: unknown, levels: number): unknown =>
    levels === 0 ? inner : Object.assign(new Error('wrap'), { cause: nest(inner, levels - 1) });

  it('pgErrorCode and pgErrorOf share the same depth limit of five', () => {
    const deepest = nest(pgErr('23505'), 4);
    expect(pgErrorCode(deepest)).toBe('23505');
    expect(pgErrorOf(deepest)?.code).toBe('23505');
    const tooDeep = nest(pgErr('23505'), 5);
    expect(pgErrorCode(tooDeep)).toBeUndefined();
    expect(pgErrorOf(tooDeep)).toBeNull();
  });
});

describe('safeErrorMessage names', () => {
  it('uses the class name when name is the generic Error', () => {
    class SomeDriverError extends Error {}
    expect(safeErrorMessage(new SomeDriverError('x'))).toBe('SomeDriverError: x');
  });
});

describe('mapPgErrors details', () => {
  it('keeps the original error as cause', async () => {
    const original = pgErr('23505', 'x_uq');
    const err = await mapPgErrors('audience', 'id1', () => Promise.reject(original)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoConflictError);
    expect((err as Error).cause).toBe(original);
    const fk = pgErr('23503', 'x_fk');
    const nf = await mapPgErrors('destination', 'id2', () => Promise.reject(fk)).catch(
      (e: unknown) => e,
    );
    expect(nf).toBeInstanceOf(RepoNotFoundError);
    expect((nf as Error).cause).toBe(fk);
    expect(nf).toMatchObject({ entity: 'destination', id: 'id2', constraint: 'x_fk' });
  });

  it('rethrows privilege and RLS WITH CHECK violations (42501) unchanged', async () => {
    const original = pgErr('42501');
    await expect(mapPgErrors('audience', 'id3', () => Promise.reject(original))).rejects.toBe(
      original,
    );
  });
});

describe('safeErrorMessage echoed input', () => {
  it('withholds values echoed by JSON SyntaxError, pg data exceptions and their wrappers', () => {
    let parseError: unknown;
    try {
      JSON.parse('bot123:SECRET-JSON');
    } catch (err) {
      parseError = err;
    }
    expect(safeErrorMessage(parseError)).toBe('SyntaxError: Unexpected token [redacted]');
    const dataErr = Object.assign(new Error('invalid input syntax for type uuid: "SECRET-UUID"'), {
      code: '22P02',
    });
    expect(safeErrorMessage(dataErr)).toBe('Error: invalid input syntax for type uuid: [redacted]');
    const wrapped = new Error(`load failed: ${(parseError as Error).message}`, {
      cause: parseError,
    });
    expect(safeErrorMessage(wrapped)).toBe('Error: load failed: Unexpected token [redacted]');
    const unique = Object.assign(
      new Error('duplicate key value violates unique constraint "x_uq"'),
      {
        code: '23505',
      },
    );
    expect(safeErrorMessage(unique)).toBe(
      'Error: duplicate key value violates unique constraint "x_uq"',
    );
  });
});
