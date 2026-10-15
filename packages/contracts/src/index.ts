import { SEVERITIES } from '@owlwire/core/message';
import { z } from 'zod';

/** Links end up in chat messages and the web UI, so only http and https are allowed. */
const HttpUrl = z.url({ protocol: /^https?$/ });

export const EventInput = z.object({
  type: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/),
  severity: z.enum(SEVERITIES).optional(),
  title: z.string().max(256).optional(),
  body: z.string().min(1).max(8000),
  fields: z
    .array(
      z.object({
        label: z.string().max(64),
        value: z.string().max(1024),
        inline: z.boolean().optional(),
      }),
    )
    .max(20)
    .optional(),
  url: HttpUrl.optional(),
  imageUrl: HttpUrl.optional(),
  groupKey: z.string().max(128).optional(),
  summary: z.string().max(256).optional(),
  locale: z.string().max(16).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});
export type EventInput = z.infer<typeof EventInput>;

export const HookJsonInput = z.object({
  title: z.string().max(256).optional(),
  body: z.string().min(1).max(8000),
});
export type HookJsonInput = z.infer<typeof HookJsonInput>;

export const EventAccepted = z.object({ eventId: z.string(), duplicate: z.boolean() });
export type EventAccepted = z.infer<typeof EventAccepted>;

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

export const DevDelivery = z.object({
  id: z.string(),
  eventId: z.string(),
  eventType: z.string(),
  eventTitle: z.string().nullable(),
  destinationName: z.string(),
  platform: z.string(),
  status: DeliveryStatus,
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});
export type DevDelivery = z.infer<typeof DevDelivery>;

export const DevDeliveryList = z.object({ deliveries: z.array(DevDelivery) });
export type DevDeliveryList = z.infer<typeof DevDeliveryList>;

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
] as const;
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export const ProblemDetails = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.enum(PROBLEM_CODES),
  detail: z.string().optional(),
});
export type ProblemDetails = z.infer<typeof ProblemDetails>;
export * from './api/account.js';
export * from './api/workspaces.js';
