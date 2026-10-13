import { sql } from 'drizzle-orm';
import { check, pgTable, uuid } from 'drizzle-orm/pg-core';
import { destinations } from './destinations.js';
import { rules } from './rules.js';
import { workspaces } from './workspaces.js';

export const ruleTargets = pgTable(
  'rule_targets',
  {
    id: uuid('id').primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id),
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => rules.id, { onDelete: 'cascade' }),
    destinationId: uuid('destination_id').references(() => destinations.id),
    audienceId: uuid('audience_id'),
  },
  (t) => [
    check(
      'rule_targets_exactly_one_check',
      sql`(${t.destinationId} is null) <> (${t.audienceId} is null)`,
    ),
  ],
);
