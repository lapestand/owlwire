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
