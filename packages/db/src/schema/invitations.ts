import type { InvitableRole } from '@owlwire/core';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { literalsOf, tstz } from './types.js';
import { workspaces } from './workspaces.js';

const ROLES = literalsOf<InvitableRole>()(['admin', 'member']);

/** Pending or accepted invitation into a workspace. Tenant table (RLS on workspace_id). */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => authUser.id, { onDelete: 'set null' }),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('invitations_role_check', sql`${t.role} in ('admin', 'member')`),
    check('invitations_email_lower_check', sql`${t.email} = lower(${t.email})`),
    unique('invitations_id_workspace_uq').on(t.id, t.workspaceId),
    index('invitations_workspace_id_idx').on(t.workspaceId),
    index('invitations_email_idx').on(t.email),
  ],
);
