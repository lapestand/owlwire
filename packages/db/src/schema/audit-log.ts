import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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
    // ms precision: the keyset cursor is a JS Date, so stored values must not be finer than that
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date', precision: 3 })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('audit_log_workspace_created_idx').on(t.workspaceId, t.createdAt.desc(), t.id.desc()),
  ],
);
