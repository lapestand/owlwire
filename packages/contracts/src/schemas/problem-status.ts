export const PROBLEM_CODES = [
  'unauthorized',
  'forbidden',
  'not_found',
  'validation_failed',
  'rate_limited',
  'conflict',
  'unknown_type',
  'installation_revoked',
  'payload_too_large',
  'internal',
  'unavailable',
  'app_not_approved',
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

/** Default HTTP status per problem code. A ProblemError may override it, e.g. malformed JSON is 400. */
export const PROBLEM_STATUS: Record<ProblemCode, number> = {
  unauthorized: 401,
  installation_revoked: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  validation_failed: 422,
  unknown_type: 422,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
  app_not_approved: 403,
};
