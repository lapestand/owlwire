import { PERSONAL_SLUG_PATTERN, personalSlug } from '@owlwire/core';
import {
  revokeInvitation,
  SYSTEM_ACTOR,
  softDeleteWorkspace,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { listAuditActions, seedCommunityWorkspace, seedInvitation } from '@owlwire/db/fixtures';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ensurePersonalWorkspace } from '../system/personal-workspace.js';
import {
  getRegistrationMode,
  getRegistrationSetting,
  hasPendingInvitation,
  setRegistrationMode,
} from '../system/registration.js';
import { listWorkspacesForUser } from '../system/user-workspaces.js';
import { findUserByEmail } from '../system/users.js';
import {
  type AuthHarness,
  createAuthHarness,
  TEST_PASSWORD,
  uniqueEmail,
} from '../test/auth-harness.js';
import { createHarness } from '../test/harness.js';
import {
  hashInvitationToken,
  INVITATION_TOKEN_PREFIX,
  INVITATION_TTL_MS,
  newInvitationToken,
} from '../workspaces/invitation-token.js';
import { runAsBootstrap } from './bootstrap-context.js';
import { createAuthHooks } from './hooks.js';

// Sign-up answers every request with the same 200 and no session (a new email, a taken email, a refused
// registration), so refusals are asserted by their effect: no user row.

/** The actor user ids (null: the system) of the workspace's audit entries, by action. */
async function auditActors(
  ownerPool: pg.Pool,
  workspaceId: string,
): Promise<Record<string, string | null>> {
  const { rows } = await ownerPool.query<{ action: string; actor_user_id: string | null }>(
    'SELECT action, actor_user_id FROM audit_log WHERE workspace_id = $1',
    [workspaceId],
  );
  return Object.fromEntries(rows.map((r) => [r.action, r.actor_user_id]));
}

describe('registration modes', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ registration: 'open' });
  });
  afterAll(async () => {
    await h.close();
  });

  const communityOwnedByNewUser = async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const owner = await h.createUser();
    return { owner, workspaceId: await seedCommunityWorkspace(h.deps.db, owner.id) };
  };

  it('open: sign-up creates a personal workspace owned by the user', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const u = await h.createUser(undefined, { name: 'Ayşe' });
    const list = await listWorkspacesForUser(h.deps, u.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      kind: 'personal',
      role: 'owner',
      ownerUserId: u.id,
      slug: personalSlug(u.id),
      name: 'Ayşe',
    });
    expect(u.personalWorkspaceId).toBe(list[0]?.id);
    expect((await listAuditActions(h.deps.db, u.personalWorkspaceId ?? '')).sort()).toEqual([
      'member.added',
      'workspace.created',
    ]);
    expect(await auditActors(h.harness.ownerPool, u.personalWorkspaceId ?? '')).toEqual({
      'member.added': u.id,
      'workspace.created': u.id,
    });
  });

  it('closed: sign-up is refused and no user is created', async () => {
    await setRegistrationMode(h.deps, 'closed', SYSTEM_ACTOR);
    const email = uniqueEmail('closed');
    const res = await h.signUp(email);
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(await findUserByEmail(h.deps, email)).toBeNull();
    expect((await h.signInResponse(email)).status).toBe(401);
  });

  it('closed: the bootstrap context bypasses the gate, sends no email and gets a personal workspace', async () => {
    await setRegistrationMode(h.deps, 'closed', SYSTEM_ACTOR);
    const email = uniqueEmail('boot');
    const res = await runAsBootstrap(() =>
      h.deps.auth.api.signUpEmail({ body: { email, password: TEST_PASSWORD, name: 'Boot' } }),
    );
    expect(res.user.email).toBe(email);
    const personal = await listWorkspacesForUser(h.deps, res.user.id);
    expect(personal).toMatchObject([{ kind: 'personal', role: 'owner', name: 'Boot' }]);
    // The command line made it, not the user.
    expect(await auditActors(h.harness.ownerPool, personal[0]?.id ?? '')).toEqual({
      'member.added': null,
      'workspace.created': null,
    });
    // Mail goes out in the background: let an ordinary sign-up's mail arrive first, then check the bootstrap one
    // never did.
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const other = uniqueEmail('after-boot');
    expect((await h.signUp(other)).status).toBe(200);
    await vi.waitFor(() => expect(h.mailer.outbox.some((m) => m.to === other)).toBe(true));
    expect(h.mailer.outbox.some((m) => m.to === email)).toBe(false);
  });

  /** A pending invitation for `email` in a fresh community workspace, with its plain token. */
  const invitedWithToken = async (email: string, expiresAt?: Date) => {
    const { owner, workspaceId } = await communityOwnedByNewUser();
    const { token, tokenHash } = newInvitationToken();
    const { id } = await seedInvitation(h.deps.db, {
      workspaceId,
      email,
      invitedBy: owner.id,
      tokenHash,
      expiresAt: expiresAt ?? new Date(h.deps.clock.now().getTime() + INVITATION_TTL_MS),
    });
    return { token, workspaceId, invitationId: id };
  };

  /** Signs up in invite mode and answers whether a user row was created. */
  const signUpInInviteMode = async (email: string, invitationToken?: string) => {
    await setRegistrationMode(h.deps, 'invite', SYSTEM_ACTOR);
    const res = await h.signUp(email, invitationToken ? { invitationToken } : {});
    expect(res.status).toBe(200);
    return (await findUserByEmail(h.deps, email)) !== null;
  };

  it('invite: email sign-up without the token is refused, even with a pending invitation', async () => {
    const email = uniqueEmail('no-token');
    await invitedWithToken(email);
    expect(await hasPendingInvitation(h.deps, email)).toBe(true);
    expect(await signUpInInviteMode(email)).toBe(false);
  });

  it('invite: email sign-up with the token of the address is admitted regardless of case', async () => {
    const email = uniqueEmail('invitee');
    const { token } = await invitedWithToken(email);
    await setRegistrationMode(h.deps, 'invite', SYSTEM_ACTOR);
    expect((await h.signUp(email.toUpperCase(), { invitationToken: token })).status).toBe(200);
    const user = await findUserByEmail(h.deps, email);
    expect(user?.email).toBe(email);
    // Signing up does not accept the invitation; the new user gets only a personal workspace.
    expect(
      (await listWorkspacesForUser(h.deps, user?.id ?? '')).map((w) => [w.kind, w.role]),
    ).toEqual([['personal', 'owner']]);
  });

  it('invite: the token of another address does not admit', async () => {
    const { token } = await invitedWithToken(uniqueEmail('someone-else'));
    expect(await signUpInInviteMode(uniqueEmail('squatter'), token)).toBe(false);
  });

  it('invite: an expired invitation does not admit', async () => {
    const email = uniqueEmail('expired');
    const { token } = await invitedWithToken(
      email,
      new Date(h.deps.clock.now().getTime() - 60_000),
    );
    expect(await hasPendingInvitation(h.deps, email)).toBe(false);
    expect(await signUpInInviteMode(email, token)).toBe(false);
  });

  it('invite: an accepted invitation does not admit', async () => {
    const email = uniqueEmail('accepted');
    const { token, invitationId } = await invitedWithToken(email);
    await h.harness.ownerPool.query('UPDATE invitations SET accepted_at = now() WHERE id = $1', [
      invitationId,
    ]);
    expect(await signUpInInviteMode(email, token)).toBe(false);
  });

  it('invite: a revoked invitation does not admit', async () => {
    const email = uniqueEmail('revoked');
    const { token, workspaceId, invitationId } = await invitedWithToken(email);
    expect(
      await withTenant(h.deps.db, tenantScope(workspaceId), (t) =>
        revokeInvitation(t, invitationId, SYSTEM_ACTOR),
      ),
    ).toBe(true);
    expect(await signUpInInviteMode(email, token)).toBe(false);
  });

  it('invite: an invitation of a deleted workspace does not admit', async () => {
    const email = uniqueEmail('deleted-ws');
    const { token, workspaceId } = await invitedWithToken(email);
    await withTenant(h.deps.db, tenantScope(workspaceId), (t) =>
      softDeleteWorkspace(t, SYSTEM_ACTOR),
    );
    expect(await signUpInInviteMode(email, token)).toBe(false);
  });

  it('invite: a malformed token does not admit', async () => {
    const email = uniqueEmail('malformed');
    const { token } = await invitedWithToken(email);
    for (const bad of ['garbage', INVITATION_TOKEN_PREFIX, `${token}x`, token.toUpperCase()]) {
      expect(await signUpInInviteMode(email, bad)).toBe(false);
    }
  });

  it('invite: a server-side sign-up without request headers is refused', async () => {
    const email = uniqueEmail('server-side');
    await invitedWithToken(email);
    await setRegistrationMode(h.deps, 'invite', SYSTEM_ACTOR);
    await h.deps.auth.api
      .signUpEmail({ body: { email, password: TEST_PASSWORD, name: 'Server' } })
      .catch(() => undefined);
    expect(await findUserByEmail(h.deps, email)).toBeNull();
  });

  it('open: the invitation header is ignored', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const email = uniqueEmail('open-header');
    expect((await h.signUp(email, { invitationToken: 'garbage' })).status).toBe(200);
    expect(await findUserByEmail(h.deps, email)).not.toBeNull();
  });

  it('closed: a valid invitation token does not admit', async () => {
    const email = uniqueEmail('closed-token');
    const { token } = await invitedWithToken(email);
    await setRegistrationMode(h.deps, 'closed', SYSTEM_ACTOR);
    expect((await h.signUp(email, { invitationToken: token })).status).toBe(200);
    expect(await findUserByEmail(h.deps, email)).toBeNull();
  });

  it('stores the mode in instance_settings and reports the source', async () => {
    await setRegistrationMode(h.deps, 'invite', SYSTEM_ACTOR);
    expect(await getRegistrationSetting(h.deps)).toEqual({ mode: 'invite', source: 'settings' });
    expect(await getRegistrationMode(h.deps)).toBe('invite');
  });

  it('ensurePersonalWorkspace returns the existing workspace to concurrent callers', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const u = await h.createUser();
    const [a, b] = await Promise.all([
      ensurePersonalWorkspace(h.deps, { id: u.id, name: u.name }),
      ensurePersonalWorkspace(h.deps, { id: u.id, name: u.name }),
    ]);
    expect(a).toBe(b);
    expect(a).toBe(u.personalWorkspaceId);
    const personal = (await listWorkspacesForUser(h.deps, u.id)).filter(
      (w) => w.kind === 'personal',
    );
    expect(personal).toHaveLength(1);
  });

  it('ensurePersonalWorkspace replaces a deleted personal workspace with a new one', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const u = await h.createUser();
    const old = u.personalWorkspaceId ?? '';
    await withTenant(h.deps.db, tenantScope(old), (t) => softDeleteWorkspace(t, SYSTEM_ACTOR));
    const fresh = await ensurePersonalWorkspace(h.deps, { id: u.id, name: u.name });
    expect(fresh).not.toBe(old);
    const list = await listWorkspacesForUser(h.deps, u.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: fresh,
      kind: 'personal',
      role: 'owner',
      ownerUserId: u.id,
    });
    // The deleted workspace keeps its slug; the new one takes another slug from the personal namespace.
    expect(list[0]?.slug).toMatch(PERSONAL_SLUG_PATTERN);
    expect(list[0]?.slug).not.toBe(personalSlug(u.id));
    expect(await ensurePersonalWorkspace(h.deps, { id: u.id, name: u.name })).toBe(fresh);
  });

  it('ensurePersonalWorkspace makes exactly one replacement when callers race after a soft delete', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const u = await h.createUser();
    const old = u.personalWorkspaceId ?? '';
    await withTenant(h.deps.db, tenantScope(old), (t) => softDeleteWorkspace(t, SYSTEM_ACTOR));
    // Every caller finds the personal slug taken by the deleted workspace and falls back to a fresh id; the unique
    // index on the live personal workspace of an owner lets one of them win.
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => ensurePersonalWorkspace(h.deps, { id: u.id, name: u.name })),
    );
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).not.toBe(old);
    const { rows } = await h.harness.ownerPool.query(
      `SELECT id FROM workspaces WHERE owner_user_id = $1 AND kind = 'personal' AND deleted_at IS NULL`,
      [u.id],
    );
    expect(rows).toEqual([{ id: ids[0] }]);
  });

  it('names the personal workspace after the user, within the workspace name limit', async () => {
    await setRegistrationMode(h.deps, 'open', SYSTEM_ACTOR);
    const blank = await h.createUser(undefined, { name: '   ' });
    const long = await h.createUser(undefined, { name: `  ${'ğ'.repeat(120)}  ` });
    const [b] = await listWorkspacesForUser(h.deps, blank.id);
    const [l] = await listWorkspacesForUser(h.deps, long.id);
    expect(b?.name).toBe('Personal');
    expect(l?.name).toBe('ğ'.repeat(80));
  });
});

describe('registration source without a stored setting', () => {
  it('falls back to the edition config (personal profile → closed)', async () => {
    const h = await createHarness();
    try {
      expect(await getRegistrationSetting(h.deps)).toEqual({ mode: 'closed', source: 'config' });
    } finally {
      await h.close();
    }
  });

  it('ignores a stored value that is not a registration mode', async () => {
    const h = await createHarness();
    try {
      await h.ownerPool.query(
        `insert into instance_settings (key, value, updated_at) values ('registration', '"sometimes"', now())`,
      );
      expect(await getRegistrationSetting(h.deps)).toEqual({ mode: 'closed', source: 'config' });
    } finally {
      await h.close();
    }
  });
});

describe('invitation tokens', () => {
  it('are ow_inv_ tokens stored only by their hash', () => {
    const { token, tokenHash } = newInvitationToken();
    expect(token.startsWith(INVITATION_TOKEN_PREFIX)).toBe(true);
    expect(tokenHash).toBe(hashInvitationToken(token));
    expect(tokenHash).not.toContain(token);
    expect(newInvitationToken().token).not.toBe(token);
    expect(INVITATION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('post sign-up hook failure', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({
      registration: 'open',
      hooks: (base) => ({
        ...createAuthHooks(base),
        async afterUserCreate() {
          throw new Error('boom');
        },
      }),
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('keeps the sign-up successful even if the personal workspace could not be created', async () => {
    const email = uniqueEmail('hookfail');
    expect((await h.signUp(email)).status).toBe(200);
    const user = await findUserByEmail(h.deps, email);
    expect(user).not.toBeNull();
    expect(await listWorkspacesForUser(h.deps, user?.id ?? '')).toHaveLength(0);
  });

  it('lets a later repair create exactly one personal workspace, even when callers race', async () => {
    const u = await h.createUser();
    expect(u.personalWorkspaceId).toBeNull();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () => ensurePersonalWorkspace(h.deps, { id: u.id, name: u.name })),
    );
    expect(new Set(ids).size).toBe(1);
    const list = await listWorkspacesForUser(h.deps, u.id);
    expect(list).toMatchObject([{ id: ids[0], kind: 'personal', role: 'owner' }]);
  });

  it('repairs the personal workspace through /api/me as the system', async () => {
    const u = await h.createUser();
    expect(u.personalWorkspaceId).toBeNull();
    const res = await h.request('/api/me', { cookie: u.cookie });
    expect(res.status).toBe(200);
    const { personalWorkspaceId } = (await res.json()) as { personalWorkspaceId: string };
    expect(await auditActors(h.harness.ownerPool, personalWorkspaceId)).toEqual({
      'member.added': null,
      'workspace.created': null,
    });
  });
});
