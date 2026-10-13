import { sql } from 'drizzle-orm';
import { boolean, check, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { installations } from './installations.js';
import { tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const rules = pgTable(
  'rules',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    installationId: uuid('installation_id')
      .notNull()
      .references(() => installations.id),
    name: text('name').notNull(),
    types: text('types').array().notNull(),
    minSeverity: text('min_severity').notNull().default('info'),
    filter: jsonb('filter'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    check(
      'rules_min_severity_check',
      sql`${t.minSeverity} in ('info', 'low', 'medium', 'high', 'critical')`,
    ),
    index('rules_installation_idx').on(t.installationId),
  ],
);
