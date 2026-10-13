import type { Context } from 'hono';
import { ProblemError } from './problem.js';
import type { AppEnv } from './types.js';

export function isJsonContentType(c: Context<AppEnv>): boolean {
  return (c.req.header('content-type') ?? '').toLowerCase().includes('application/json');
}

export async function readJsonBody(c: Context<AppEnv>): Promise<unknown> {
  if (!isJsonContentType(c)) {
    throw new ProblemError(422, 'validation_failed', 'expected content-type application/json');
  }
  const text = await c.req.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProblemError(400, 'validation_failed', 'request body is not valid JSON');
  }
}

export function idempotencyHeader(c: Context<AppEnv>): string | undefined {
  const value = c.req.header('idempotency-key')?.trim();
  if (!value) return undefined;
  if (value.length > 128) {
    throw new ProblemError(
      422,
      'validation_failed',
      'Idempotency-Key header must be at most 128 characters',
    );
  }
  return value;
}
