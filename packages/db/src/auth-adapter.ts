import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { dbInternals, type OwlwireDb } from './handle.js';
import {
  authAccount,
  authPasskey,
  authRateLimit,
  authSession,
  authTwoFactor,
  authUser,
  authVerification,
} from './schema/index.js';

/** Keys must equal the modelName values the server's Better Auth configuration gives each model. */
export const authSchema = {
  auth_user: authUser,
  auth_session: authSession,
  auth_account: authAccount,
  auth_verification: authVerification,
  auth_two_factor: authTwoFactor,
  auth_passkey: authPasskey,
  // rateLimit.modelName: the database store for Better Auth's rate limiter.
  auth_rate_limit: authRateLimit,
};

/**
 * Better Auth reaches the auth_* tables through the opaque handle; Drizzle never leaves the package. Those
 * tables are instance-level and have no tenant RLS, so the adapter works outside withTenant and withSystem. Pass the
 * auth role's handle (owlwire_auth): the application role cannot read the session, account, verification,
 * two-factor, passkey or rate-limit tables, and sees only a few auth_user columns.
 */
export function authAdapter(db: OwlwireDb): ReturnType<typeof drizzleAdapter> {
  return drizzleAdapter(dbInternals(db).drizzle, { provider: 'pg', schema: authSchema });
}
