import {
  AuditDataError,
  InvalidScopeError,
  LAST_OWNER,
  RepoConflictError,
  RepoInputError,
  RepoNotFoundError,
} from '@owlwire/db';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { AUDIT_DATA_DETAIL, NOT_FOUND_DETAIL, type ProblemError, problem } from '../../problem.js';
import {
  CROSS_SITE_DETAIL,
  crossSiteGuard,
  decisionProblem,
  httpProblem,
  INVALID_INPUT_DETAIL,
  MALFORMED_JSON_DETAIL,
  repositoryProblem,
  UNSUPPORTED_MEDIA_TYPE_DETAIL,
} from './problems.js';

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

describe('httpProblem', () => {
  it('keeps the client error status and uses fixed details', () => {
    expect(httpProblem(400)).toMatchObject({ status: 400, detail: MALFORMED_JSON_DETAIL });
    expect(httpProblem(415)).toMatchObject({
      status: 415,
      code: 'validation_failed',
      detail: UNSUPPORTED_MEDIA_TYPE_DETAIL,
    });
    expect(httpProblem(404)).toMatchObject({ status: 404, detail: NOT_FOUND_DETAIL });
    expect(httpProblem(413)).toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(httpProblem(405)).toMatchObject({ status: 405, code: 'validation_failed' });
  });
});

describe('crossSiteGuard', () => {
  const app = new Hono();
  app.onError((err, c) => problem(c, err as ProblemError));
  app.use('*', crossSiteGuard('https://owl.example/'));
  app.all('/x', (c) => c.text('ok'));
  const send = (method: string, headers: Record<string, string>) =>
    app.request('https://owl.example/x', { method, headers });

  it('refuses unsafe methods from another origin or a cross-site fetch', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const refused: Array<Record<string, string>> = [
        { origin: 'https://evil.example' },
        { origin: 'https://owl.example.evil.example' },
        { origin: 'http://owl.example' },
        { 'sec-fetch-site': 'cross-site' },
      ];
      for (const headers of refused) {
        const res = await send(method, headers);
        expect(res.status, `${method} ${JSON.stringify(headers)}`).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'forbidden', detail: CROSS_SITE_DETAIL });
      }
    }
  });

  it('passes the public origin, header-less clients and safe methods', async () => {
    expect((await send('POST', { origin: 'https://owl.example' })).status).toBe(200);
    expect((await send('POST', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await send('POST', {})).status).toBe(200);
    expect(
      (await send('GET', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))
        .status,
    ).toBe(200);
  });
});
