import type { InvitableRole } from '@owlwire/core';
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { literalsOf, sqlList, tstz } from './types.js';
import { workspaces } from './workspaces.js';

const INVITATION_ROLES = literalsOf<InvitableRole>()(['admin', 'member']);

/** Pending or accepted invitation into a workspace. Tenant table (RLS on workspace_id). */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role', { enum: INVITATION_ROLES }).notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    invitedBy: uuid('invited_by').references(() => authUser.id, { onDelete: 'set null' }),
    expiresAt: tstz('expires_at').notNull(),
    acceptedAt: tstz('accepted_at'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('invitations_role_check', sql`${t.role} in (${sqlList(INVITATION_ROLES)})`),
    check('invitations_email_lower_check', sql`${t.email} = lower(${t.email})`),
    unique('invitations_id_workspace_uq').on(t.id, t.workspaceId),
    // At most one open invitation per address and workspace, so two concurrent invites cannot leave two live
    // tokens. Revoking deletes the row and a re-invite replaces the open one, so only accepted rows are kept.
    uniqueIndex('invitations_pending_email_uidx')
      .on(t.workspaceId, t.email)
      .where(sql`${t.acceptedAt} is null`),
    index('invitations_workspace_id_idx').on(t.workspaceId),
    index('invitations_email_idx').on(t.email),
  ],
);
