import { pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const audiences = pgTable(
  'audiences',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
  },
  (t) => [
    unique('audiences_workspace_name_uq').on(t.workspaceId, t.name),
    unique('audiences_id_workspace_uq').on(t.id, t.workspaceId),
  ],
);
