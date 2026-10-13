import { describe, expect, it } from 'vitest';
import {
  mapPgErrors,
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
