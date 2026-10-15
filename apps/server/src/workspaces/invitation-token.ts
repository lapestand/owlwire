import { generateToken, hashToken, INVITATION_TOKEN_PREFIX } from '@owlwire/crypto';

export { INVITATION_TOKEN_PREFIX };

/** Invitations expire seven days after they are created. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A new invitation token (`ow_inv_` + 256 random bits) and its SHA-256 hash. Only the hash is stored; the plain token
 * goes into the invitation link once and is never logged.
 */
export function newInvitationToken(): { token: string; tokenHash: string } {
  const token = generateToken('inv');
  return { token, tokenHash: hashToken(token) };
}

export function hashInvitationToken(token: string): string {
  return hashToken(token);
}
