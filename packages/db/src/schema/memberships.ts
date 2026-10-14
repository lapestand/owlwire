import type { WorkspaceRole } from '@owlwire/core';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { literalsOf, sqlList, tstz } from './types.js';
import { workspaces } from './workspaces.js';

const MEMBERSHIP_ROLES = literalsOf<WorkspaceRole>()(['owner', 'admin', 'member']);

/**
 * A user's role in a workspace. Tenant table (RLS on workspace_id). The primary key (workspace_id, user_id)
 * already carries the workspace, so a table that references a membership gets a composite workspace key for
 * free; there is no separate id column. user_id points at the instance-level auth_user, not a tenant table.
 */
export const memberships = pgTable(
  'memberships',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    check('memberships_role_check', sql`${t.role} in (${sqlList(MEMBERSHIP_ROLES)})`),
    index('memberships_user_id_idx').on(t.userId),
  ],
);
