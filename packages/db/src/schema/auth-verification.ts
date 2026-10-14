import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './types.js';

export const authVerification = pgTable(
  'auth_verification',
  {
    id: uuid('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: tstz('expires_at').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('auth_verification_identifier_idx').on(t.identifier)],
);
