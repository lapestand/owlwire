import {
  findInvitationByTokenHash,
  type InvitationLookupRow,
  SYSTEM,
  withSystem,
} from '@owlwire/db/system';
import type { BaseDeps } from '../base-deps.js';
import { hashInvitationToken } from '../workspaces/invitation-token.js';

/**
 * The invitation behind a token, across workspaces (invitations of deleted workspaces are invisible). Every token,
 * well-formed or not, is hashed and looked up the same way, so an unknown token costs the same as a known one; the
 * lookup is an index match on the hash of a 256-bit token, which leaks nothing usable through timing.
 */
export function findInvitationByToken(
  deps: Pick<BaseDeps, 'db'>,
  token: string,
): Promise<InvitationLookupRow | null> {
  const tokenHash = hashInvitationToken(token);
  return withSystem(deps.db, SYSTEM, (s) => findInvitationByTokenHash(s, tokenHash));
}
