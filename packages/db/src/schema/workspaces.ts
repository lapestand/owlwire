import { sql } from 'drizzle-orm';
import { check, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { sqlList, tstz } from './types.js';

const WORKSPACE_KINDS = ['personal', 'community'] as const;

export const workspaces = pgTable(
  'workspaces',
  {
    id: uuid('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    kind: text('kind', { enum: WORKSPACE_KINDS }).notNull(),
    // Owner of a personal workspace; community workspaces keep their owners in memberships. RESTRICT on purpose:
    // cascading would hard-delete a tenant with its data and audit trail, and SET NULL would orphan it. Deleting a
    // user must first delete or hand over their personal workspace.
    ownerUserId: uuid('owner_user_id').references(() => authUser.id, { onDelete: 'restrict' }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    deletedAt: tstz('deleted_at'),
  },
  (t) => [
    check('workspaces_kind_check', sql`${t.kind} in (${sqlList(WORKSPACE_KINDS)})`),
    // Only a personal workspace has an owner column. Personal rows without an owner stay allowed (rows created
    // before accounts existed have none).
    check('workspaces_owner_kind_check', sql`${t.kind} = 'personal' or ${t.ownerUserId} is null`),
    // One live personal workspace per user. Soft-deleted rows do not count, matching the owner lookup, which
    // ignores them too; otherwise a deleted personal workspace would block creating a new one forever.
    uniqueIndex('workspaces_personal_owner_uidx')
      .on(t.ownerUserId)
      .where(sql`${t.kind} = 'personal' and ${t.deletedAt} is null`),
  ],
);
