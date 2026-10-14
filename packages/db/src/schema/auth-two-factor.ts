import { boolean, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { authUser } from './auth-user.js';
import { tstz } from './types.js';

export const authTwoFactor = pgTable(
  'auth_two_factor',
  {
    id: uuid('id').primaryKey(),
    secret: text('secret').notNull(),
    backupCodes: text('backup_codes').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUser.id, { onDelete: 'cascade' }),
    // Better Auth 1.7 twoFactor schema: enable writes verified = false until the first TOTP check succeeds;
    // failed checks count up and lock the factor until locked_until.
    verified: boolean('verified').notNull().default(true),
    failedVerificationCount: integer('failed_verification_count').notNull().default(0),
    lockedUntil: tstz('locked_until'),
  },
  (t) => [
    index('auth_two_factor_user_id_idx').on(t.userId),
    index('auth_two_factor_secret_idx').on(t.secret),
  ],
);
