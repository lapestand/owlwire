import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey(),
    // null = instance düzeyi kayıt (yalnız SystemScope görür)
    workspaceId: uuid('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    actorUserId: uuid('actor_user_id'),
    actorInstallationId: uuid('actor_installation_id'),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_workspace_created_idx').on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
  ],
);
