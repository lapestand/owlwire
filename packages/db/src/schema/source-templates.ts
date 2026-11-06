import type { SourceTemplateMapping } from '@owlwire/core';
import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './types.js';
import { workspaces } from './workspaces.js';

/** Per-workspace mapping from an arbitrary webhook payload to an event; installations bind to one. */
export const sourceTemplates = pgTable(
  'source_templates',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    mapping: jsonb('mapping').$type<SourceTemplateMapping>().notNull(),
    samplePayload: jsonb('sample_payload').$type<unknown>(),
    origin: text('origin').notNull().default('user'),
    originRef: text('origin_ref'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check('source_templates_origin_check', sql`${t.origin} in ('user', 'pack')`),
    unique('source_templates_workspace_key_uq').on(t.workspaceId, t.key),
    unique('source_templates_id_workspace_uq').on(t.id, t.workspaceId),
  ],
);
