import { boolean, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { tstz } from './types.js';

/**
 * No index on secret: Better Auth stores it encrypted with a random nonce and never looks a row up by it.
 */
export const authTwoFactor = pgTable('auth_two_factor', {
  id: uuid('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  // Better Auth keeps one factor per user (enable updates the existing row); unique so two concurrent enables
  // cannot leave two rows.
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => authUser.id, { onDelete: 'cascade' }),
  // Better Auth 1.7 twoFactor schema: enable writes verified = false until the first TOTP check succeeds;
  // failed checks count up and lock the factor until locked_until.
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: tstz('locked_until'),
});
