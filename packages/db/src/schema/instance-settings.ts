import { jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './types.js';

export const instanceSettings = pgTable('instance_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});
