import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canChangeRole, canRemoveMember, roleAtLeast, WORKSPACE_ROLES } from './roles.js';

describe('roleAtLeast', () => {
  it('orders roles owner > admin > member', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('member', 'admin')).toBe(false);
    expect(roleAtLeast('admin', 'owner')).toBe(false);
  });
});

describe('canChangeRole', () => {
  const base = { ownerCount: 2, personal: false };
  it.each([
    ['owner', 'member', 'admin', true, undefined],
    ['admin', 'member', 'admin', true, undefined],
    ['admin', 'admin', 'member', true, undefined],
    ['member', 'member', 'admin', false, 'forbidden'],
    ['admin', 'member', 'owner', false, 'forbidden'],
    ['admin', 'owner', 'admin', false, 'forbidden'],
    ['owner', 'admin', 'owner', true, undefined],
    ['owner', 'owner', 'admin', true, undefined],
  ] as const)('%s changing %s to %s → %s', (actorRole, targetRole, newRole, ok, reason) => {
    const d = canChangeRole({ ...base, actorRole, targetRole, newRole });
    expect(d.ok).toBe(ok);
    if (!d.ok) expect(d.reason).toBe(reason);
  });

  it('refuses to demote the last owner', () => {
    expect(
      canChangeRole({
        actorRole: 'owner',
        targetRole: 'owner',
        newRole: 'admin',
        ownerCount: 1,
        personal: false,
      }),
    ).toEqual({
      ok: false,
      reason: 'last_owner',
    });
  });

  it('refuses owner changes in a personal workspace', () => {
    expect(
      canChangeRole({
        actorRole: 'owner',
        targetRole: 'member',
        newRole: 'owner',
        ownerCount: 1,
        personal: true,
      }),
    ).toEqual({
      ok: false,
      reason: 'personal_workspace',
    });
    expect(
      canChangeRole({
        actorRole: 'owner',
        targetRole: 'member',
        newRole: 'admin',
        ownerCount: 1,
        personal: true,
      }).ok,
    ).toBe(true);
  });
});

describe('canRemoveMember', () => {
  const base = { ownerCount: 2, targetIsPersonalOwner: false };
  it.each([
    ['owner', 'admin', false, true, undefined],
    ['owner', 'owner', false, true, undefined],
    ['admin', 'member', false, true, undefined],
    ['admin', 'admin', false, false, 'forbidden'],
    ['admin', 'owner', false, false, 'forbidden'],
    ['member', 'member', false, false, 'forbidden'],
    ['member', 'member', true, true, undefined],
    ['admin', 'admin', true, true, undefined],
  ] as const)('%s removing %s (self=%s) → %s', (actorRole, targetRole, isSelf, ok, reason) => {
    const d = canRemoveMember({ ...base, actorRole, targetRole, isSelf });
    expect(d.ok).toBe(ok);
    if (!d.ok) expect(d.reason).toBe(reason);
  });

  it('refuses removing or leaving as the last owner', () => {
    expect(
      canRemoveMember({
        actorRole: 'owner',
        targetRole: 'owner',
        isSelf: true,
        ownerCount: 1,
        targetIsPersonalOwner: false,
      }),
    ).toEqual({
      ok: false,
      reason: 'last_owner',
    });
  });

  it('refuses removing the personal workspace owner', () => {
    expect(
      canRemoveMember({
        actorRole: 'owner',
        targetRole: 'owner',
        isSelf: true,
        ownerCount: 1,
        targetIsPersonalOwner: true,
      }),
    ).toEqual({
      ok: false,
      reason: 'personal_workspace',
    });
  });
});

describe('role invariants', () => {
  const role = fc.constantFrom(...WORKSPACE_ROLES);

  it('roleAtLeast is a total order', () => {
    fc.assert(
      fc.property(role, role, role, (a, b, c) => {
        expect(roleAtLeast(a, b) || roleAtLeast(b, a)).toBe(true);
        if (roleAtLeast(a, b) && roleAtLeast(b, a)) expect(a).toBe(b);
        if (roleAtLeast(a, b) && roleAtLeast(b, c)) expect(roleAtLeast(a, c)).toBe(true);
      }),
    );
  });

  it('never leaves a workspace without an owner', () => {
    fc.assert(
      fc.property(
        role,
        role,
        role,
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        (actorRole, targetRole, newRole, ownerCount, personal) => {
          const d = canChangeRole({ actorRole, targetRole, newRole, ownerCount, personal });
          if (d.ok && targetRole === 'owner' && newRole !== 'owner')
            expect(ownerCount).toBeGreaterThan(1);
        },
      ),
    );
    fc.assert(
      fc.property(
        role,
        role,
        fc.boolean(),
        fc.integer({ min: 1, max: 3 }),
        fc.boolean(),
        (actorRole, targetRole, isSelf, ownerCount, targetIsPersonalOwner) => {
          const d = canRemoveMember({
            actorRole,
            targetRole,
            isSelf,
            ownerCount,
            targetIsPersonalOwner,
          });
          if (d.ok && targetRole === 'owner') expect(ownerCount).toBeGreaterThan(1);
        },
      ),
    );
  });
});
