import { describe, expect, it } from 'vitest';
import {
  canChangeRole,
  canRemoveMember,
  type MemberDecision,
  roleAtLeast,
  WORKSPACE_ROLES,
} from './roles.js';

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

describe('canChangeRole no-op', () => {
  it('allows a change to the current role when the actor may make the change', () => {
    for (const personal of [false, true])
      expect(
        canChangeRole({
          actorRole: 'owner',
          targetRole: 'owner',
          newRole: 'owner',
          ownerCount: 1,
          personal,
        }),
      ).toEqual({ ok: true });
  });

  it('still needs the permission the change would need', () => {
    for (const personal of [false, true]) {
      expect(
        canChangeRole({
          actorRole: 'admin',
          targetRole: 'owner',
          newRole: 'owner',
          ownerCount: 1,
          personal,
        }),
      ).toEqual({ ok: false, reason: 'forbidden' });
      expect(
        canChangeRole({
          actorRole: 'member',
          targetRole: 'member',
          newRole: 'member',
          ownerCount: 1,
          personal,
        }),
      ).toEqual({ ok: false, reason: 'forbidden' });
    }
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

describe('exhaustive role rules', () => {
  const R = WORKSPACE_ROLES;
  const touchesOwner = (t: string, n: string) => t === 'owner' || n === 'owner';

  it('roleAtLeast is a total order over all pairs', () => {
    for (const a of R) {
      for (const b of R) {
        expect(roleAtLeast(a, b) || roleAtLeast(b, a)).toBe(true);
        if (roleAtLeast(a, b) && roleAtLeast(b, a)) expect(a).toBe(b);
        for (const c of R)
          if (roleAtLeast(a, b) && roleAtLeast(b, c)) expect(roleAtLeast(a, c)).toBe(true);
      }
    }
  });

  it('canChangeRole matches the rule table for every combination', () => {
    for (const actorRole of R)
      for (const targetRole of R)
        for (const newRole of R)
          for (const personal of [false, true])
            for (const ownerCount of [1, 2]) {
              const d = canChangeRole({ actorRole, targetRole, newRole, ownerCount, personal });
              const owner = touchesOwner(targetRole, newRole);
              let expected: MemberDecision;
              const noop = targetRole === newRole;
              if (personal && owner && !noop)
                expected = { ok: false, reason: 'personal_workspace' };
              else if (owner ? actorRole !== 'owner' : actorRole === 'member')
                expected = { ok: false, reason: 'forbidden' };
              else if (targetRole === 'owner' && newRole !== 'owner' && ownerCount === 1)
                expected = { ok: false, reason: 'last_owner' };
              else expected = { ok: true };
              expect(d).toEqual(expected);
              // only an owner can touch an owner; a member can never act
              if (d.ok && owner) expect(actorRole).toBe('owner');
              if (actorRole === 'member') expect(d.ok).toBe(false);
              if (d.ok && targetRole === 'owner' && newRole !== 'owner') expect(ownerCount).toBe(2);
            }
  });

  it('canRemoveMember matches the rule table for every combination', () => {
    for (const actorRole of R)
      for (const targetRole of R)
        for (const isSelf of [false, true])
          for (const targetIsPersonalOwner of [false, true])
            for (const ownerCount of [1, 2]) {
              const d = canRemoveMember({
                actorRole,
                targetRole,
                isSelf,
                ownerCount,
                targetIsPersonalOwner,
              });
              let expected: MemberDecision;
              if (targetIsPersonalOwner) expected = { ok: false, reason: 'personal_workspace' };
              else if (isSelf || actorRole === 'owner')
                expected =
                  targetRole === 'owner' && ownerCount === 1
                    ? { ok: false, reason: 'last_owner' }
                    : { ok: true };
              else if (actorRole === 'admin' && targetRole === 'member') expected = { ok: true };
              else expected = { ok: false, reason: 'forbidden' };
              expect(d).toEqual(expected);
              // a member can only ever remove themselves; nobody below owner removes an owner
              if (d.ok && actorRole === 'member') expect(isSelf).toBe(true);
              if (d.ok && targetRole === 'owner' && !isSelf) expect(actorRole).toBe('owner');
              if (d.ok && targetRole === 'owner') expect(ownerCount).toBe(2);
            }
  });
});
