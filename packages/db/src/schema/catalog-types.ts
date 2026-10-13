import { sql } from 'drizzle-orm';
import { check, jsonb, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { apps } from './apps.js';
import { tstz } from './types.js';

export const catalogTypes = pgTable(
  'catalog_types',
  {
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    defaultSeverity: text('default_severity').notNull().default('info'),
    payloadSchema: jsonb('payload_schema'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'catalog_types_pk', columns: [t.appId, t.key] }),
    check(
      'catalog_types_default_severity_check',
      sql`${t.defaultSeverity} in ('info','low','medium','high','critical')`,
    ),
  ],
);
