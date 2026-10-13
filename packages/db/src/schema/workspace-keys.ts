import { sql } from 'drizzle-orm';
import { check, integer, pgTable, uuid } from 'drizzle-orm/pg-core';
import { bytea, tstz } from './types.js';
import { workspaces } from './workspaces.js';

export const workspaceKeys = pgTable(
  'workspace_keys',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    wrappedDek: bytea('wrapped_dek').notNull(),
    kekVersion: integer('kek_version').notNull(),
    createdAt: tstz('created_at').notNull().defaultNow(),
    rotatedAt: tstz('rotated_at'),
  },
  (t) => [check('workspace_keys_kek_version_check', sql`${t.kekVersion} > 0`)],
);
