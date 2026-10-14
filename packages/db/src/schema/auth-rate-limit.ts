import { bigint, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';

/**
 * Better Auth rate limit store (rateLimit.storage = 'database'), so several server replicas share the same
 * counters. One row per bucket key.
 */
export const authRateLimit = pgTable('auth_rate_limit', {
  id: uuid('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  // Better Auth writes the time of the last request as a number of milliseconds since the epoch.
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});
