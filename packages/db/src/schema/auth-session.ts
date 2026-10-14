import { index, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { tstz } from './types.js';

export const authSession = pgTable(
  'auth_session',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: tstz('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: tstz('created_at').notNull().defaultNow(),
    updatedAt: tstz('updated_at').notNull().defaultNow(),
  },
  (t) => [index('auth_session_user_id_idx').on(t.userId)],
);
