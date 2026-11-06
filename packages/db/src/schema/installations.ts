import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { apps } from './apps.js';
import { authUser } from './auth-user.js';
import { sourceTemplates } from './source-templates.js';
import { tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const installations = pgTable(
  'installations',
  {
    id: uuid('id').primaryKey(),
    appId: uuid('app_id')
      .notNull()
      .references(() => apps.id),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    status: text('status').notNull().default('active'),
    externalRef: text('external_ref'),
    grantedTypes: text('granted_types').array(),
    tokenHash: text('token_hash').notNull().unique(),
    tokenPrefix: text('token_prefix').notNull(),
    createdByUserId: uuid('created_by_user_id').references(() => authUser.id, {
      onDelete: 'set null',
    }),
    createdAt: tstz('created_at').notNull().defaultNow(),
    revokedAt: tstz('revoked_at'),
    sourceTemplateId: uuid('source_template_id'),
  },
  (t) => [
    check('installations_status_check', sql`${t.status} in ('active', 'revoked')`),
    unique('installations_id_workspace_uq').on(t.id, t.workspaceId),
    foreignKey({
      name: 'installations_source_template_ws_fk',
      columns: [t.sourceTemplateId, t.workspaceId],
      foreignColumns: [sourceTemplates.id, sourceTemplates.workspaceId],
    }).onDelete('restrict'),
  ],
);
