import { sql } from 'drizzle-orm';
import { check, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { bytea, tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const apps = pgTable(
  'apps',
  {
    id: uuid('id').primaryKey(),
    ownerWorkspaceId: uuid('owner_workspace_id')
      .notNull()
      .references(() => workspaces.id),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    visibility: text('visibility').notNull(),
    approvalStatus: text('approval_status').notNull().default('approved'),
    description: text('description'),
    homepageUrl: text('homepage_url'),
    appKeyHash: text('app_key_hash'),
    appKeyPrefix: text('app_key_prefix'),
    statusWebhookUrl: text('status_webhook_url'),
    statusWebhookSecretEnc: bytea('status_webhook_secret_enc'),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    check('apps_visibility_check', sql`${t.visibility} in ('private', 'public')`),
    check(
      'apps_approval_status_check',
      sql`${t.approvalStatus} in ('approved', 'pending', 'rejected')`,
    ),
  ],
);
