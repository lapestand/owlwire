// Only the schema's constants are used here; the schema never imports this module, so there is no import cycle.
import {
  PROFILE_REGISTRATION_DEFAULTS,
  type PROFILES,
  type REGISTRATION_MODES,
} from './config/schema.js';

export type RegistrationMode = (typeof REGISTRATION_MODES)[number];
export type RegistrationDecision =
  | { allowed: true }
  | { allowed: false; reason: 'registration_closed' | 'invitation_required' };

export function decideRegistration(i: {
  mode: RegistrationMode;
  bootstrap: boolean;
  hasPendingInvitation: boolean;
}): RegistrationDecision {
  if (i.bootstrap || i.mode === 'open') return { allowed: true };
  if (i.mode === 'invite') {
    return i.hasPendingInvitation
      ? { allowed: true }
      : { allowed: false, reason: 'invitation_required' };
  }
  return { allowed: false, reason: 'registration_closed' };
}

export function defaultRegistrationForProfile(
  profile: (typeof PROFILES)[number],
): RegistrationMode {
  return PROFILE_REGISTRATION_DEFAULTS[profile];
}
