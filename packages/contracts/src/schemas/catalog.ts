import { z } from '@hono/zod-openapi';
import { GENERIC_TYPE_KEY, RESERVED_TYPE_PREFIX } from '@owlwire/core';
import { SEVERITIES } from '@owlwire/core/message';
import { TypeKey } from './events.js';

export const MAX_PAYLOAD_SCHEMA_BYTES = 16 * 1024;
export const MAX_CATALOG_TYPES_PER_PUT = 200;
export const RESERVED_TYPE_KEYS: readonly string[] = [GENERIC_TYPE_KEY];

/** `generic` and every `owlwire.*` key are owned by Owlwire and cannot be defined by an app. */
export function isReservedTypeKey(key: string): boolean {
  return RESERVED_TYPE_KEYS.includes(key) || key.startsWith(RESERVED_TYPE_PREFIX);
}

export const CatalogTypeInput = z
  .object({
    key: TypeKey,
    name: z.string().min(1).max(128),
    description: z.string().max(1024).optional(),
    defaultSeverity: z.enum(SEVERITIES).default('info'),
    payloadSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .openapi('CatalogTypeInput');
export type CatalogTypeInput = z.infer<typeof CatalogTypeInput>;

export const CatalogPutInput = z
  .object({ types: z.array(CatalogTypeInput).min(1).max(MAX_CATALOG_TYPES_PER_PUT) })
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.types.forEach((t, i) => {
      if (seen.has(t.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['types', i, 'key'],
          message: `duplicate key "${t.key}"`,
        });
      }
      seen.add(t.key);
      if (isReservedTypeKey(t.key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['types', i, 'key'],
          message: `"${t.key}" is reserved`,
        });
      }
      if (t.payloadSchema) {
        const bytes = new TextEncoder().encode(JSON.stringify(t.payloadSchema)).byteLength;
        if (bytes > MAX_PAYLOAD_SCHEMA_BYTES) {
          ctx.addIssue({
            code: 'custom',
            path: ['types', i, 'payloadSchema'],
            message: `payloadSchema exceeds ${MAX_PAYLOAD_SCHEMA_BYTES} bytes`,
          });
        }
      }
    });
  })
  .openapi('CatalogPutInput');
export type CatalogPutInput = z.infer<typeof CatalogPutInput>;

export const CatalogType = z
  .object({
    key: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    defaultSeverity: z.enum(SEVERITIES),
    payloadSchema: z.record(z.string(), z.unknown()).nullable(),
    updatedAt: z.string(),
  })
  .openapi('CatalogType');
export type CatalogType = z.infer<typeof CatalogType>;

export const CatalogResponse = z.object({ types: z.array(CatalogType) }).openapi('CatalogResponse');
export type CatalogResponse = z.infer<typeof CatalogResponse>;
