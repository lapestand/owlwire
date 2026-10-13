import type { ProblemCode } from '@owlwire/contracts';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

const TITLES: Record<ProblemCode, string> = {
  unauthorized: 'Unauthorized',
  forbidden: 'Forbidden',
  not_found: 'Not Found',
  validation_failed: 'Validation Failed',
  rate_limited: 'Too Many Requests',
  conflict: 'Conflict',
  unknown_type: 'Unknown Notification Type',
  installation_revoked: 'Installation Revoked',
  payload_too_large: 'Payload Too Large',
  internal: 'Internal Server Error',
  unavailable: 'Service Unavailable',
};

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

export function problemBody(status: number, code: ProblemCode, detail?: string) {
  return {
    type: `https://owlwire.dev/errors/${code}`,
    title: TITLES[code],
    status,
    code,
    ...(detail ? { detail } : {}),
  };
}

export function problem(c: Context, err: ProblemError): Response {
  for (const [key, value] of Object.entries(err.headers)) c.header(key, value);
  return c.body(JSON.stringify(problemBody(err.status, err.code, err.detail)), err.status, {
    'content-type': 'application/problem+json',
  });
}

export function validationProblem(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): ProblemError {
  const detail = issues
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ')
    .slice(0, 1000);
  return new ProblemError(422, 'validation_failed', detail);
}
