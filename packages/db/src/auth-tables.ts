/** The Better Auth tables. Instance-level: no workspace_id and no tenant RLS. */
export const AUTH_TABLES = [
  'auth_user',
  'auth_session',
  'auth_account',
  'auth_verification',
  'auth_two_factor',
  'auth_passkey',
  'auth_rate_limit',
] as const;

export type AuthTable = (typeof AUTH_TABLES)[number];

/**
 * Auth tables the application role cannot touch at all: password hashes and OAuth tokens (auth_account), session
 * tokens (auth_session), reset and verification tokens (auth_verification), 2FA secrets and backup codes
 * (auth_two_factor), passkeys (auth_passkey) and the per-IP sign-in counters (auth_rate_limit). Only the auth role
 * (owlwire_auth), which the auth library alone connects as, reads and writes them.
 */
export const AUTH_SECRET_TABLES = AUTH_TABLES.filter(
  (t): t is Exclude<AuthTable, 'auth_user'> => t !== 'auth_user',
);

/**
 * The auth_user columns the application role may SELECT: what tenant code shows about a user (member lists join
 * name and email). Everything else about a user, and every write, goes through the auth role.
 */
export const APP_AUTH_USER_COLUMNS = ['id', 'name', 'email', 'image'] as const;
