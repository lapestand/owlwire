import { describe, expect, it } from 'vitest';
import { toSessionUser } from './session-auth.js';

describe('toSessionUser', () => {
  const base = { id: 'u1', email: 'a@x.test', name: 'A', emailVerified: true };

  it('keeps only the API fields and treats missing or null flags as false', () => {
    expect(
      toSessionUser({ ...base, isInstanceAdmin: null, extra: 'dropped' } as Parameters<
        typeof toSessionUser
      >[0]),
    ).toEqual({ ...base, isInstanceAdmin: false, twoFactorEnabled: false });
  });

  it('passes true flags through', () => {
    expect(toSessionUser({ ...base, isInstanceAdmin: true, twoFactorEnabled: true })).toEqual({
      ...base,
      isInstanceAdmin: true,
      twoFactorEnabled: true,
    });
  });
});
