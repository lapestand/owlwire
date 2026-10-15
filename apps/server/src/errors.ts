import type { ProblemCode } from '@owlwire/contracts';
import {
  AuditDataError,
  InvalidScopeError,
  LAST_OWNER,
  RepoConflictError,
  RepoInputError,
  RepoNotFoundError,
} from '@owlwire/db';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * Errors the server's services raise for the caller. They carry the status, the problem code and a fixed detail; the
 * http layer only renders them as RFC 9457 problem details, so services never depend on the http modules.
 */
export class ProblemError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: ProblemCode;
  readonly detail: string | undefined;
  readonly headers: Record<string, string>;

  constructor(
    status: ContentfulStatusCode,
    code: ProblemCode,
    detail?: string,
    headers: Record<string, string> = {},
  ) {
    super(detail ?? code);
    this.name = 'ProblemError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

/** RFC 6750 challenge sent with every installation-token 401 (middleware and ingest). */
export const BEARER_CHALLENGE = { 'www-authenticate': 'Bearer' };

/**
 * Fixed detail of the 404 for repository not-found and invalid scope errors (same text for both, so the response
 * does not reveal which one happened).
 */
export const NOT_FOUND_DETAIL = 'The requested resource was not found.';

/** Fixed detail of the 422 for audit guard rejections; the guard's own message may name input keys. */
export const AUDIT_DATA_DETAIL = 'The request contains data that cannot be recorded.';

/** Fixed detail of the 422 for repository input errors; the repository reason is not passed on. */
export const INVALID_INPUT_DETAIL = 'The request contains invalid input.';

/** The same body as the repository not-found 404: unknown, foreign, deleted and malformed ids look alike. */
export function notFound(): ProblemError {
  return new ProblemError(404, 'not_found', NOT_FOUND_DETAIL);
}

export function decisionProblem(d: {
  ok: false;
  reason: 'forbidden' | 'last_owner' | 'personal_workspace';
}): ProblemError {
  return d.reason === 'forbidden'
    ? new ProblemError(403, 'forbidden')
    : new ProblemError(409, 'conflict', d.reason);
}

/**
 * Problem for an error the data layer raised, or null when the error is not one of them. Every detail is a fixed
 * text or a known reason code; nothing from the request or the database row is echoed.
 */
export function repositoryProblem(err: unknown): ProblemError | null {
  if (err instanceof RepoNotFoundError || err instanceof InvalidScopeError) return notFound();
  if (err instanceof RepoConflictError) {
    return new ProblemError(
      409,
      'conflict',
      err.constraint === LAST_OWNER ? LAST_OWNER : undefined,
    );
  }
  if (err instanceof RepoInputError) {
    return new ProblemError(422, 'validation_failed', INVALID_INPUT_DETAIL);
  }
  if (err instanceof AuditDataError) {
    return new ProblemError(422, 'validation_failed', AUDIT_DATA_DETAIL);
  }
  return null;
}
