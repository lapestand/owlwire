import {
  type AuthUserRow,
  countInstanceAdmins as countAdmins,
  findAuthUserByEmail,
  findAuthUserById,
  markEmailVerified,
  SYSTEM,
  withSystem,
} from '@owlwire/db/system';
import type { BaseDeps } from '../deps.js';

// auth_user flags (instance admin, two-factor) and every auth_user write are reachable only through the auth role.

export function findUserByEmail(
  deps: Pick<BaseDeps, 'authDb'>,
  email: string,
): Promise<AuthUserRow | null> {
  return withSystem(deps.authDb, SYSTEM, (s) => findAuthUserByEmail(s, email));
}

export function findUserById(
  deps: Pick<BaseDeps, 'authDb'>,
  id: string,
): Promise<AuthUserRow | null> {
  return withSystem(deps.authDb, SYSTEM, (s) => findAuthUserById(s, id));
}

export function markUserEmailVerified(
  deps: Pick<BaseDeps, 'authDb'>,
  userId: string,
): Promise<void> {
  return withSystem(deps.authDb, SYSTEM, (s) => markEmailVerified(s, userId));
}

export function countInstanceAdmins(deps: Pick<BaseDeps, 'authDb'>): Promise<number> {
  return withSystem(deps.authDb, SYSTEM, (s) => countAdmins(s));
}
