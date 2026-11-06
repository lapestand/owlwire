import { createRoute, z } from '@hono/zod-openapi';
import { CatalogPutInput, CatalogResponse } from '../schemas/catalog.js';
import {
  EventAccepted,
  EventBatchResponse,
  EventStatusResponse,
  EventsPostBody,
  HookJsonInput,
} from '../schemas/events.js';
import { IdempotencyHeaders, jsonContent, problemResponses, UuidParam } from './common.js';

export const postEventsRoute = createRoute({
  method: 'post',
  path: '/v1/events',
  tags: ['events'],
  summary: 'Send one event or a batch of up to 100 events',
  security: [{ installationToken: [] }],
  request: {
    headers: IdempotencyHeaders,
    body: { required: true, content: { 'application/json': { schema: EventsPostBody } } },
  },
  responses: {
    202: jsonContent(
      z.union([EventAccepted, EventBatchResponse]),
      'Accepted (or already accepted: duplicate=true)',
    ),
    ...problemResponses(400, 401, 403, 413, 422, 429),
  },
});

export const getEventRoute = createRoute({
  method: 'get',
  path: '/v1/events/{id}',
  tags: ['events'],
  summary: 'Delivery summary of an event sent by this installation',
  security: [{ installationToken: [] }],
  request: { params: z.object({ id: UuidParam('id') }) },
  responses: {
    200: jsonContent(EventStatusResponse, 'Event status'),
    ...problemResponses(401, 403, 404, 422, 429),
  },
});

export const postHooksRoute = createRoute({
  method: 'post',
  path: '/v1/hooks',
  tags: ['events'],
  summary: 'Send a plain notification of type "generic" (one-line curl friendly)',
  description:
    'Any non-JSON content type (text/plain, curl -d form bodies) is read as the raw message body. The token may be passed as ?token= instead of the Authorization header.',
  security: [{ installationToken: [] }],
  request: {
    headers: IdempotencyHeaders,
    query: z.object({
      token: z
        .string()
        .optional()
        .openapi({ description: 'Installation token when headers cannot be set' }),
    }),
    body: {
      required: true,
      content: {
        'text/plain': { schema: z.string().openapi({ example: 'Plate 34 ABC 123 at gate 1' }) },
        'application/json': { schema: HookJsonInput },
      },
    },
  },
  responses: {
    202: jsonContent(EventAccepted, 'Accepted'),
    ...problemResponses(400, 401, 403, 413, 422, 429),
  },
});

// Typed up front: as an inline literal, the two differently shaped alternatives widen createRoute's inferred
// config to plain RouteConfig, and the handler would lose its typed body.
const catalogSecurity: Array<Record<string, string[]>> = [
  { appKey: [] },
  { installationToken: [] },
];

export const putCatalogRoute = createRoute({
  method: 'put',
  path: '/v1/catalog',
  tags: ['catalog'],
  summary: 'Create or update notification types of the calling app (upsert, never deletes)',
  security: catalogSecurity,
  request: {
    body: { required: true, content: { 'application/json': { schema: CatalogPutInput } } },
  },
  responses: {
    200: jsonContent(CatalogResponse, 'The whole catalog after the update'),
    ...problemResponses(400, 401, 403, 413, 422, 429),
  },
});
