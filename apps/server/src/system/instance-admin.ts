import { randomBytes } from 'node:crypto';
import { SYSTEM_ACTOR } from '@owlwire/db';
import {
  findAuthUserByEmail,
  grantInstanceAdmin,
  markEmailVerified,
  SYSTEM,
  withSystem,
} from '@owlwire/db/system';
import { MIN_PASSWORD_LENGTH } from '../auth/auth.js';
import { runAsBootstrap } from '../auth/bootstrap-context.js';
import type { Deps } from '../deps.js';

/** The email or the password given to `owlwire admin create` is not acceptable; checked before any database access. */
export class AdminInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminInputError';
  }
}

/**
 * A sign-up for the same email ran between the command's existence check and its own sign-up, so the stored account
 * is not the one the command made, and its password is someone else's. Nothing is changed. The message names the
 * promote path and says to check ownership first; that path then says whether the account's email is verified.
 */
export class ConcurrentAdminUserError extends Error {
  constructor(email: string) {
    super(
      `an account with the email ${email} already exists and was not created by this command; nothing was ` +
        'changed. Promoting an existing account makes whoever controls it an instance admin: only if you have ' +
        `checked that it is yours, promote it with \`owlwire admin create --email ${email}\`.`,
    );
    this.name = 'ConcurrentAdminUserError';
  }
}

export interface AdminInput {
  email: string;
  name: string;
  password?: string;
}

export interface BootstrapInstanceAdminResult {
  userId: string;
  created: boolean;
  /** Only for a new user without a provided password; shown to the operator once and never stored in clear. */
  generatedPassword: string | null;
  /** An existing user keeps their password: a provided one is not applied. */
  passwordIgnored: boolean;
  /**
   * Whether the account's email is verified. A created admin always is; a promoted account may not be, and then
   * nothing proves that the address owner made it.
   */
  emailVerified: boolean;
}

/** The sign-in library's default maxPasswordLength; a longer password would fail inside sign-up. */
export const MAX_PASSWORD_LENGTH = 128;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 18 random bytes: a 24 character base64url password. */
const GENERATED_PASSWORD_BYTES = 18;

/**
 * Lower-cases and trims the email, defaults the name to the email's local part and checks the password length
 * (MIN_PASSWORD_LENGTH to MAX_PASSWORD_LENGTH). The
 * error message names the email the operator typed, never the password.
 */
export function normalizeAdminInput(raw: {
  email: string;
  name?: string;
  password?: string;
}): AdminInput {
  const email = raw.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new AdminInputError(`invalid email: ${raw.email}`);
  if (raw.password !== undefined && raw.password.length < MIN_PASSWORD_LENGTH) {
    throw new AdminInputError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (raw.password !== undefined && raw.password.length > MAX_PASSWORD_LENGTH) {
    throw new AdminInputError(`password must be at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  const name = raw.name?.trim() || email.split('@')[0] || email;
  return { email, name, ...(raw.password !== undefined ? { password: raw.password } : {}) };
}

/**
 * `owlwire admin create`: promotes an existing user, or creates a new one with a verified email (with or without
 * SMTP) and makes them an instance admin. The new user goes through the sign-in library inside the bootstrap context,
 * which bypasses the registration mode (a closed instance needs this for its first admin) and the verification email;
 * the default hooks still create the personal workspace. auth_user is written through the auth role.
 */
export async function bootstrapInstanceAdmin(
  deps: Pick<Deps, 'authDb' | 'auth'>,
  raw: { email: string; name?: string; password?: string },
): Promise<BootstrapInstanceAdminResult> {
  const input = normalizeAdminInput(raw);
  const existing = await withSystem(deps.authDb, SYSTEM, (s) =>
    findAuthUserByEmail(s, input.email),
  );
  if (existing) {
    await withSystem(deps.authDb, SYSTEM, (s) => grantInstanceAdmin(s, existing.id, SYSTEM_ACTOR));
    return {
      userId: existing.id,
      created: false,
      generatedPassword: null,
      passwordIgnored: input.password !== undefined,
      emailVerified: existing.emailVerified,
    };
  }

  const generatedPassword =
    input.password === undefined
      ? randomBytes(GENERATED_PASSWORD_BYTES).toString('base64url')
      : null;
  const password = input.password ?? generatedPassword ?? '';
  const signedUp = await runAsBootstrap(() =>
    deps.auth.api.signUpEmail({ body: { email: input.email, password, name: input.name } }),
  );
  // Sign-up answers some failures with a generic success and a user that was never stored, so the stored row is the
  // source of truth. For an email taken in the meantime that generic answer carries a made-up id, and the stored row
  // belongs to whoever signed up first: it must not be promoted with a password the command never set.
  const created = await withSystem(deps.authDb, SYSTEM, (s) => findAuthUserByEmail(s, input.email));
  if (!created) throw new Error('the sign-in library did not create the admin user');
  if (created.id !== signedUp.user.id) throw new ConcurrentAdminUserError(input.email);
  await withSystem(deps.authDb, SYSTEM, async (s) => {
    await markEmailVerified(s, created.id);
    await grantInstanceAdmin(s, created.id, SYSTEM_ACTOR);
  });
  return {
    userId: created.id,
    created: true,
    generatedPassword,
    passwordIgnored: false,
    emailVerified: true,
  };
}
