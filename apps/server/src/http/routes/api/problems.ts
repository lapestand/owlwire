import { ProblemDetails, type WorkspaceDto } from '@owlwire/contracts';
import { roleAtLeast, type WorkspaceRole } from '@owlwire/core';
import {
  AuditDataError,
  InvalidScopeError,
  LAST_OWNER,
  RepoConflictError,
  RepoInputError,
  RepoNotFoundError,
} from '@owlwire/db';
import type { MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { AUDIT_DATA_DETAIL, NOT_FOUND_DETAIL, ProblemError } from '../../problem.js';
import type { WorkspaceContext } from './env.js';

/** Every management route is internal: the web UI uses it, it is not a public integration API. */
export const TAGS = ['internal'];
export const SECURITY = [{ cookieAuth: [] as string[] }];

/** Fixed detail of the 422 for repository input errors; the repository reason is not passed on. */
export const INVALID_INPUT_DETAIL = 'The request contains invalid input.';

export function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

const PROBLEM_DESCRIPTIONS = {
  400: 'Malformed JSON',
  401: 'No valid session',
  403: 'Insufficient role',
  404: 'Not found',
  409: 'Conflict',
  422: 'Validation failed',
} as const;
type ProblemStatus = keyof typeof PROBLEM_DESCRIPTIONS;

export function problems(...codes: ProblemStatus[]) {
  return Object.fromEntries(
    codes.map((c) => [c, json(ProblemDetails, PROBLEM_DESCRIPTIONS[c])]),
  ) as Record<ProblemStatus, ReturnType<typeof json<typeof ProblemDetails>>>;
}

/** The same body as the repository not-found 404: unknown, foreign, deleted and malformed ids look alike. */
export function notFound(): ProblemError {
  return new ProblemError(404, 'not_found', NOT_FOUND_DETAIL);
}

/** 403 forbidden unless the caller's role in the workspace is at least `min`. */
export function assertRole(ws: WorkspaceContext, min: WorkspaceRole): void {
  if (!roleAtLeast(ws.role, min)) throw new ProblemError(403, 'forbidden');
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

/** Fixed details for client errors raised by the framework; the framework's own messages may quote the request. */
export const MALFORMED_JSON_DETAIL = 'The request body is not valid JSON.';
export const UNSUPPORTED_MEDIA_TYPE_DETAIL = 'The request body must be JSON (application/json).';
export const CROSS_SITE_DETAIL = 'Cross-site requests cannot change data.';

/** Problem for a 4xx the framework raised (HTTPException). Status is kept, the detail is fixed. */
export function httpProblem(status: number): ProblemError {
  const s = status as ContentfulStatusCode;
  switch (status) {
    case 400:
      return new ProblemError(400, 'validation_failed', MALFORMED_JSON_DETAIL);
    case 401:
      return new ProblemError(401, 'unauthorized');
    case 403:
      return new ProblemError(403, 'forbidden');
    case 404:
      return notFound();
    case 413:
      return new ProblemError(413, 'payload_too_large');
    case 415:
      return new ProblemError(415, 'validation_failed', UNSUPPORTED_MEDIA_TYPE_DETAIL);
    case 429:
      return new ProblemError(429, 'rate_limited');
    default:
      return new ProblemError(s, 'validation_failed');
  }
}

const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Refuses state-changing requests a browser sent from another site: an Origin header other than the public origin,
 * or Sec-Fetch-Site: cross-site, answers 403. Requests with neither header (non-browser clients) pass. This sits on
 * top of the SameSite=Lax session cookie and the JSON-only bodies.
 */
export function crossSiteGuard(publicUrl: string): MiddlewareHandler {
  const allowed = new URL(publicUrl).origin;
  return async (c, next) => {
    if (UNSAFE_METHODS.has(c.req.method)) {
      const origin = c.req.header('origin');
      const site = c.req.header('sec-fetch-site');
      if ((origin !== undefined && origin !== allowed) || site === 'cross-site') {
        throw new ProblemError(403, 'forbidden', CROSS_SITE_DETAIL);
      }
    }
    await next();
  };
}

export function toWorkspaceDto(ws: WorkspaceContext): WorkspaceDto {
  return {
    id: ws.id,
    name: ws.name,
    slug: ws.slug,
    kind: ws.kind,
    role: ws.role,
    createdAt: ws.createdAt.toISOString(),
  };
}
