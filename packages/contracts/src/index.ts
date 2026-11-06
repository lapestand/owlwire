import { z } from '@hono/zod-openapi';
import { PROBLEM_CODES } from './schemas/problem-status.js';

export const DELIVERY_STATUSES = [
  'pending',
  'scheduled',
  'sending',
  'delivered',
  'failed',
  'suppressed',
  'digested',
] as const;
export const DeliveryStatus = z.enum(DELIVERY_STATUSES);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const ProblemDetails = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    code: z.enum(PROBLEM_CODES),
    detail: z.string().optional(),
  })
  .openapi('ProblemDetails');
export type ProblemDetails = z.infer<typeof ProblemDetails>;
export * from './api/account.js';
export * from './api/audit.js';
export * from './api/workspaces.js';
export * from './schemas/apps.js';
export * from './schemas/catalog.js';
export * from './schemas/events.js';
export * from './schemas/installations.js';
export * from './schemas/problem-status.js';
