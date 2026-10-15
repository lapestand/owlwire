import { REGISTRATION_MODES, type RegistrationMode } from '@owlwire/core';
import type { AuditActor } from '@owlwire/db';
import {
  getInstanceSetting,
  hasPendingInvitationForEmail,
  SYSTEM,
  setInstanceSetting,
  withSystem,
} from '@owlwire/db/system';
import { z } from 'zod';
import type { BaseDeps } from '../base-deps.js';
import { findInvitationByToken } from './invitation-lookup.js';

const KEY = 'registration';
const ModeSchema = z.enum(REGISTRATION_MODES);

export interface RegistrationSetting {
  mode: RegistrationMode;
  source: 'settings' | 'config';
}

/**
 * The stored instance setting wins; without one (or with a value that is not a mode) the edition config applies,
 * whose default already depends on the profile.
 */
export async function getRegistrationSetting(
  deps: Pick<BaseDeps, 'db' | 'config'>,
): Promise<RegistrationSetting> {
  const stored = await withSystem(deps.db, SYSTEM, (s) => getInstanceSetting(s, KEY));
  const parsed = ModeSchema.safeParse(stored);
  if (parsed.success) return { mode: parsed.data, source: 'settings' };
  return { mode: deps.config.edition.registration, source: 'config' };
}

export async function getRegistrationMode(
  deps: Pick<BaseDeps, 'db' | 'config'>,
): Promise<RegistrationMode> {
  return (await getRegistrationSetting(deps)).mode;
}

/** Stores the mode; setInstanceSetting writes the instance-level settings.updated audit entry in the same transaction. */
export async function setRegistrationMode(
  deps: Pick<BaseDeps, 'db'>,
  mode: RegistrationMode,
  actor: AuditActor,
): Promise<void> {
  const value = ModeSchema.parse(mode);
  await withSystem(deps.db, SYSTEM, (s) => setInstanceSetting(s, KEY, value, actor));
}

/** Whether a live workspace holds an open, unexpired invitation for the email (case-insensitive). */
export function hasPendingInvitation(deps: Pick<BaseDeps, 'db'>, email: string): Promise<boolean> {
  return withSystem(deps.db, SYSTEM, (s) => hasPendingInvitationForEmail(s, email));
}

/**
 * Whether `token` belongs to an open, unexpired invitation of a live workspace for exactly this (lower-cased) email.
 * Fails closed: no token, an unknown or malformed one, or any mismatch is false. Every token is hashed and looked up
 * the same way as on the public invitation lookup, so this costs no more and tells no more than that endpoint.
 */
export async function invitationAdmits(
  deps: Pick<BaseDeps, 'db' | 'clock'>,
  email: string,
  token: string | null,
): Promise<boolean> {
  if (!token) return false;
  const inv = await findInvitationByToken(deps, token);
  return (
    inv !== null &&
    inv.acceptedAt === null &&
    inv.expiresAt > deps.clock.now() &&
    inv.email === email
  );
}
