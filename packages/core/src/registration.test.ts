import { describe, expect, it } from 'vitest';
import { decideRegistration, defaultRegistrationForProfile } from './registration.js';

describe('decideRegistration', () => {
  it('allows everyone in open mode', () => {
    expect(
      decideRegistration({ mode: 'open', bootstrap: false, hasPendingInvitation: false }),
    ).toEqual({ allowed: true });
  });
  it('requires an invitation in invite mode', () => {
    expect(
      decideRegistration({ mode: 'invite', bootstrap: false, hasPendingInvitation: false }),
    ).toEqual({
      allowed: false,
      reason: 'invitation_required',
    });
    expect(
      decideRegistration({ mode: 'invite', bootstrap: false, hasPendingInvitation: true }),
    ).toEqual({ allowed: true });
  });
  it('refuses everyone in closed mode except the bootstrap command', () => {
    expect(
      decideRegistration({ mode: 'closed', bootstrap: false, hasPendingInvitation: true }),
    ).toEqual({
      allowed: false,
      reason: 'registration_closed',
    });
    expect(
      decideRegistration({ mode: 'closed', bootstrap: true, hasPendingInvitation: false }),
    ).toEqual({ allowed: true });
  });
  it('maps profiles to default modes', () => {
    expect(defaultRegistrationForProfile('personal')).toBe('closed');
    expect(defaultRegistrationForProfile('community')).toBe('invite');
    expect(defaultRegistrationForProfile('open')).toBe('open');
  });
});
