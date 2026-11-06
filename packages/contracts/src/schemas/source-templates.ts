import { z } from '@hono/zod-openapi';
import { SLUG_PATTERN } from '@owlwire/core';
import { EventInput } from './events.js';

const Mapping = z.record(z.string(), z.unknown()).openapi({
  description: 'Text fields rendered on { payload, headers }; validated by the server.',
});

export const SourceTemplateView = z
  .object({
    id: z.string().uuid(),
    key: z.string(),
    name: z.string(),
    description: z.string(),
    mapping: Mapping,
    samplePayload: z.unknown().nullable(),
    origin: z.enum(['user', 'pack']),
    originRef: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .openapi('SourceTemplateView');
export type SourceTemplateView = z.infer<typeof SourceTemplateView>;

export const SourceTemplateListResponse = z
  .object({ items: z.array(SourceTemplateView) })
  .openapi('SourceTemplateListResponse');
export type SourceTemplateListResponse = z.infer<typeof SourceTemplateListResponse>;

const Name = z.string().min(1).max(100);
const Description = z.string().max(500);

export const SourceTemplateCreateInput = z
  .object({
    key: z
      .string()
      .regex(SLUG_PATTERN, 'key must be 3-40 characters of a-z, 0-9 and single dashes'),
    name: Name,
    description: Description.optional(),
    mapping: Mapping,
    samplePayload: z.unknown().optional(),
  })
  .strict()
  .openapi('SourceTemplateCreateInput');
export type SourceTemplateCreateInput = z.infer<typeof SourceTemplateCreateInput>;

export const SourceTemplateUpdateInput = z
  .object({
    name: Name.optional(),
    description: Description.optional(),
    mapping: Mapping.optional(),
    samplePayload: z.unknown().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'at least one field is required',
  })
  .openapi('SourceTemplateUpdateInput');
export type SourceTemplateUpdateInput = z.infer<typeof SourceTemplateUpdateInput>;

const PreviewSample = {
  payload: z.unknown(),
  headers: z.record(z.string(), z.string()).optional(),
};

export const SourceTemplatePreviewInput = z
  .union([
    z.object({ mapping: Mapping, ...PreviewSample }).strict(),
    z.object({ templateId: z.string().uuid(), ...PreviewSample }).strict(),
  ])
  .openapi('SourceTemplatePreviewInput');
export type SourceTemplatePreviewInput = z.infer<typeof SourceTemplatePreviewInput>;

export const SourceTemplatePreviewResult = z
  .discriminatedUnion('ok', [
    z.object({ ok: z.literal(true), event: EventInput }),
    z.object({
      ok: z.literal(false),
      errors: z.array(z.object({ path: z.string(), message: z.string() })),
    }),
  ])
  .openapi('SourceTemplatePreviewResult');
export type SourceTemplatePreviewResult = z.infer<typeof SourceTemplatePreviewResult>;
