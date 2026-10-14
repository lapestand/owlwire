import { sql } from 'drizzle-orm';
import { check, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { tstz } from './types.js';

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    kind: text('kind', { enum: ['personal', 'community'] }).notNull(),
    // Owner of a personal workspace; community workspaces keep their owners in memberships.
    ownerUserId: uuid('owner_user_id').references(() => authUser.id),
    createdAt: tstz('created_at').notNull().defaultNow(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    check('workspaces_kind_check', sql`${t.kind} in ('personal', 'community')`),
    uniqueIndex('workspaces_personal_owner_uidx')
      .on(t.ownerUserId)
      .where(sql`${t.kind} = 'personal'`),
  ],
);
