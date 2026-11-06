import { z } from '@hono/zod-openapi';
import { SEVERITIES } from '@owlwire/core/message';

export const TYPE_KEY_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const MAX_BATCH_EVENTS = 100;

/** Links end up in chat messages and the web UI, so only http and https are allowed. */
export const HttpUrl = z.url({ protocol: /^https?$/ }).max(2048);

export const TypeKey = z.string().regex(TYPE_KEY_PATTERN).openapi({ example: 'account.inactive' });
export type TypeKey = z.infer<typeof TypeKey>;

export const EventInput = z
  .object({
    type: TypeKey,
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
  })
  .openapi('EventInput');
export type EventInput = z.infer<typeof EventInput>;

export const EventBatchInput = z
  .object({ events: z.array(EventInput).min(1).max(MAX_BATCH_EVENTS) })
  .openapi('EventBatchInput');
export type EventBatchInput = z.infer<typeof EventBatchInput>;

export const EventsPostBody = z.union([EventBatchInput, EventInput]);
export type EventsPostBody = z.infer<typeof EventsPostBody>;

export const EventAccepted = z
  .object({ eventId: z.string().uuid(), duplicate: z.boolean() })
  .openapi('EventAccepted');
export type EventAccepted = z.infer<typeof EventAccepted>;

export const BATCH_ITEM_ERROR_CODES = ['unknown_type', 'forbidden', 'validation_failed'] as const;
export type BatchItemErrorCode = (typeof BATCH_ITEM_ERROR_CODES)[number];

export const EventBatchItemError = z
  .object({ error: z.object({ code: z.enum(BATCH_ITEM_ERROR_CODES), detail: z.string() }) })
  .openapi('EventBatchItemError');
export type EventBatchItemError = z.infer<typeof EventBatchItemError>;

export const EventBatchResultItem = z
  .union([EventAccepted, EventBatchItemError])
  .openapi('EventBatchResultItem');
export type EventBatchResultItem = z.infer<typeof EventBatchResultItem>;

export const EventBatchResponse = z
  .object({ results: z.array(EventBatchResultItem) })
  .openapi('EventBatchResponse');
export type EventBatchResponse = z.infer<typeof EventBatchResponse>;

export const EventStatusResponse = z
  .object({
    id: z.string().uuid(),
    status: z.enum(['received', 'routed']),
    deliveries: z.object({
      total: z.number().int(),
      delivered: z.number().int(),
      failed: z.number().int(),
      pending: z.number().int(),
    }),
  })
  .openapi('EventStatusResponse');
export type EventStatusResponse = z.infer<typeof EventStatusResponse>;

export const HookJsonInput = z
  .object({ title: z.string().max(256).optional(), body: z.string().min(1).max(8000) })
  .openapi('HookJsonInput');
export type HookJsonInput = z.infer<typeof HookJsonInput>;
