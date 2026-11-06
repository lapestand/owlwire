import { z } from '@hono/zod-openapi';
import { ProblemDetails } from '../index.js';

const PROBLEM_DESCRIPTIONS: Record<number, string> = {
  400: 'Malformed request (invalid JSON, header and body disagree)',
  401: 'Missing, invalid or revoked credentials',
  403: 'Not allowed (role, grant or app approval)',
  404: 'Not found or not accessible',
  409: 'Conflict with the current state',
  413: 'Request body larger than 64 KiB',
  422: 'Validation failed or unknown notification type',
  429: 'Rate limited; retry after the Retry-After header',
};

type ProblemResponse = {
  description: string;
  content: { 'application/problem+json': { schema: typeof ProblemDetails } };
};

/** OpenAPI response objects for RFC 9457 problems. */
export function problemResponses<const S extends readonly number[]>(
  ...statuses: S
): Record<S[number], ProblemResponse> {
  const out: Record<number, ProblemResponse> = {};
  for (const status of statuses) {
    out[status] = {
      description: PROBLEM_DESCRIPTIONS[status] ?? 'Error',
      content: { 'application/problem+json': { schema: ProblemDetails } },
    };
  }
  return out as Record<S[number], ProblemResponse>;
}

export function jsonContent<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { 'application/json': { schema } } };
}

export const UuidParam = (name: string) =>
  z
    .string()
    .uuid()
    .openapi({ param: { name, in: 'path' } });

export const WorkspaceParams = z.object({ workspaceId: UuidParam('workspaceId') });

export const IdempotencyHeaders = z.object({
  'idempotency-key': z
    .string()
    .max(128)
    .optional()
    .openapi({ description: 'Deduplicates retries of the same event (single events only).' }),
});
