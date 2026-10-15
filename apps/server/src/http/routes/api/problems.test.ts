import {
  AuditDataError,
  InvalidScopeError,
  LAST_OWNER,
  RepoConflictError,
  RepoInputError,
  RepoNotFoundError,
} from '@owlwire/db';
import { describe, expect, it } from 'vitest';
import { AUDIT_DATA_DETAIL, NOT_FOUND_DETAIL } from '../../problem.js';
import { decisionProblem, INVALID_INPUT_DETAIL, repositoryProblem } from './problems.js';

const SECRET = 'leaked-input-value';

describe('repositoryProblem', () => {
  it('maps not found and invalid scope to the same 404', () => {
    for (const err of [
      new RepoNotFoundError('workspace', SECRET),
      new InvalidScopeError(`bad scope ${SECRET}`),
    ]) {
      expect(repositoryProblem(err)).toMatchObject({
        status: 404,
        code: 'not_found',
        detail: NOT_FOUND_DETAIL,
      });
    }
  });

  it('maps conflicts to 409 and passes on only the last owner reason', () => {
    expect(repositoryProblem(new RepoConflictError('membership', LAST_OWNER))).toMatchObject({
      status: 409,
      code: 'conflict',
      detail: 'last_owner',
    });
    const other = repositoryProblem(new RepoConflictError('workspace', 'workspaces_slug_unique'));
    expect(other).toMatchObject({ status: 409, code: 'conflict' });
    expect(other?.detail).toBeUndefined();
  });

  it('maps input and audit data errors to 422 with fixed details', () => {
    expect(repositoryProblem(new RepoInputError('workspace', SECRET))).toMatchObject({
      status: 422,
      code: 'validation_failed',
      detail: INVALID_INPUT_DETAIL,
    });
    expect(repositoryProblem(new AuditDataError(`key ${SECRET}`))).toMatchObject({
      status: 422,
      code: 'validation_failed',
      detail: AUDIT_DATA_DETAIL,
    });
  });

  it('leaves other errors alone', () => {
    expect(repositoryProblem(new Error(SECRET))).toBeNull();
    expect(repositoryProblem('nope')).toBeNull();
  });
});

describe('decisionProblem', () => {
  it('maps forbidden to 403 and the other reasons to 409 with the reason', () => {
    expect(decisionProblem({ ok: false, reason: 'forbidden' })).toMatchObject({ status: 403 });
    expect(decisionProblem({ ok: false, reason: 'last_owner' })).toMatchObject({
      status: 409,
      detail: 'last_owner',
    });
    expect(decisionProblem({ ok: false, reason: 'personal_workspace' })).toMatchObject({
      status: 409,
      detail: 'personal_workspace',
    });
  });
});
