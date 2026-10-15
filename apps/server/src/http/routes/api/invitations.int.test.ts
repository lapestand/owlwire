import { FakeClock } from '@owlwire/core';
import { SYSTEM_ACTOR } from '@owlwire/db';
import {
  listAuditActions,
  seedCommunityWorkspace,
  seedInvitation,
  seedMembership,
} from '@owlwire/db/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../../logger.js';
import { MailMessageError } from '../../../mail/mailer.js';
import { setRegistrationMode } from '../../../system/registration.js';
import {
  type AuthHarness,
  createAuthHarness,
  TEST_BASE_URL,
  type TestUser,
  uniqueEmail,
} from '../../../test/auth-harness.js';
import { type LockedChange, setRole, underWorkspaceLock } from '../../../test/workspace-lock.js';
import { INVITATION_TTL_MS, newInvitationToken } from '../../../workspaces/invitation-token.js';

interface Created {
  invitation: { id: string; email: string; role: string };
  acceptUrl: string;
  emailSent: boolean;
}

const tokenOf = (c: Created) => decodeURIComponent(c.acceptUrl.split('/invite/')[1] ?? '');

describe('management api: invitations', () => {
  const clock = new FakeClock(new Date('2026-10-12T09:00:00Z'));
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ clock });
  });
  afterAll(async () => {
    await h.close();
  });

  async function setup(): Promise<{ ws: string; owner: TestUser; member: TestUser }> {
    const owner = await h.createUser(undefined, { name: 'Mehmet' });
    const member = await h.createUser();
    const ws = await seedCommunityWorkspace(h.deps.db, owner.id, 'Kurt Sürüsü');
    await seedMembership(h.deps.db, ws, member.id, 'member');
    return { ws, owner, member };
  }

  const invite = (ws: string, body: Record<string, unknown>, cookie: string) =>
    h.request(`/api/workspaces/${ws}/invitations`, { body, cookie });
  const lookup = (token: string) => h.request('/api/invitations/lookup', { body: { token } });
  const accept = (token: string, cookie: string) =>
    h.request('/api/invitations/accept', { body: { token }, cookie });
  const pendingIds = async (ws: string, cookie: string) =>
    (
      (await (await h.request(`/api/workspaces/${ws}/invitations`, { cookie })).json()) as {
        items: Array<{ id: string }>;
      }
    ).items.map((i) => i.id);
  const lock = (ws: string, change: LockedChange, fire: () => Promise<Response>) =>
    underWorkspaceLock(h.harness.ownerPool, ws, change, fire);

  it('creates an invitation, emails it and lists it as pending', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('Invitee');
    const res = await invite(ws, { email, role: 'admin', locale: 'tr' }, owner.cookie);
    expect(res.status).toBe(201);
    const created = (await res.json()) as Created;
    expect(created.emailSent).toBe(true);
    expect(created.invitation).toMatchObject({ email: email.toLowerCase(), role: 'admin' });
    expect(created.acceptUrl.startsWith(`${TEST_BASE_URL}/invite/ow_inv_`)).toBe(true);
    const mail = h.mailer.outbox.find((m) => m.to === email.toLowerCase());
    expect(mail?.subject).toContain('Kurt Sürüsü');
    expect(mail?.text).toContain(created.acceptUrl);
    expect(await pendingIds(ws, owner.cookie)).toContain(created.invitation.id);
    expect(await listAuditActions(h.deps.db, ws)).toContain('invitation.created');
  });

  it('forbids members, validates input and refuses existing members', async () => {
    const { ws, owner, member } = await setup();
    expect((await invite(ws, { email: uniqueEmail() }, member.cookie)).status).toBe(403);
    expect((await invite(ws, { email: 'not-an-email' }, owner.cookie)).status).toBe(422);
    expect((await invite(ws, { email: uniqueEmail(), role: 'owner' }, owner.cookie)).status).toBe(
      422,
    );
    const dup = await invite(ws, { email: member.email.toUpperCase() }, owner.cookie);
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ detail: 'already_member' });
  });

  it('lets an admin invite and cancel, but not invite an owner', async () => {
    const { ws, owner } = await setup();
    const admin = await h.createUser();
    await seedMembership(h.deps.db, ws, admin.id, 'admin');
    expect((await invite(ws, { email: uniqueEmail(), role: 'owner' }, admin.cookie)).status).toBe(
      422,
    );
    const res = await invite(ws, { email: uniqueEmail('by-admin'), role: 'admin' }, admin.cookie);
    expect(res.status).toBe(201);
    const created = (await res.json()) as Created;
    expect(created.invitation.role).toBe('admin');
    const del = await h.request(`/api/workspaces/${ws}/invitations/${created.invitation.id}`, {
      method: 'DELETE',
      cookie: admin.cookie,
    });
    expect(del.status).toBe(204);
    expect(await pendingIds(ws, owner.cookie)).not.toContain(created.invitation.id);
    const actions = await listAuditActions(h.deps.db, ws);
    expect(actions).toEqual(expect.arrayContaining(['invitation.created', 'invitation.revoked']));
  });

  it('refuses invitations into a personal workspace', async () => {
    const owner = await h.createUser();
    const personal = owner.personalWorkspaceId ?? '';
    const res = await invite(personal, { email: uniqueEmail('personal') }, owner.cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ detail: 'personal_workspace' });
    expect(await listAuditActions(h.deps.db, personal)).not.toContain('invitation.created');
  });

  it('keeps the invitation list and cancellation from plain members', async () => {
    const { ws, owner, member } = await setup();
    const created = (await (
      await invite(ws, { email: uniqueEmail('hidden') }, owner.cookie)
    ).json()) as Created;
    const list = await h.request(`/api/workspaces/${ws}/invitations`, { cookie: member.cookie });
    expect(list.status).toBe(403);
    const del = await h.request(`/api/workspaces/${ws}/invitations/${created.invitation.id}`, {
      method: 'DELETE',
      cookie: member.cookie,
    });
    expect(del.status).toBe(403);
    expect(await pendingIds(ws, owner.cookie)).toContain(created.invitation.id);
  });

  it('answers the same 404 to outsiders of the workspace', async () => {
    const { ws, owner } = await setup();
    const outsider = await h.createUser();
    const created = (await (
      await invite(ws, { email: uniqueEmail('outside') }, owner.cookie)
    ).json()) as Created;
    for (const res of [
      await h.request(`/api/workspaces/${ws}/invitations`, { cookie: outsider.cookie }),
      await invite(ws, { email: uniqueEmail() }, outsider.cookie),
      await h.request(`/api/workspaces/${ws}/invitations/${created.invitation.id}`, {
        method: 'DELETE',
        cookie: outsider.cookie,
      }),
    ]) {
      expect(res.status).toBe(404);
    }
    expect(await pendingIds(ws, owner.cookie)).toContain(created.invitation.id);
  });

  it('replaces a pending invitation when the same email is invited again', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('again');
    const first = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    const second = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    expect((await lookup(tokenOf(first))).status).toBe(404);
    const preview = await lookup(tokenOf(second));
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      workspaceName: 'Kurt Sürüsü',
      email: email.toLowerCase(),
      role: 'member',
    });
    expect(await listAuditActions(h.deps.db, ws)).toContain('invitation.revoked');
  });

  it('previews an invitation without a session and shows only the invitation fields', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('preview');
    const created = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    const res = await lookup(tokenOf(created));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaceName: 'Kurt Sürüsü',
      email: email.toLowerCase(),
      role: 'member',
      expiresAt: new Date(clock.now().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    });
    // A token without the invitation prefix is an unknown token like any other.
    expect((await lookup('x'.repeat(40))).status).toBe(404);
  });

  it('accepts an invitation for the matching user, idempotently', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('joiner');
    const created = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    const joiner = await h.createUser(email.toUpperCase());
    const first = await accept(tokenOf(created), joiner.cookie);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ workspaceId: ws, role: 'member' });
    expect((await accept(tokenOf(created), joiner.cookie)).status).toBe(200);
    expect((await h.request(`/api/workspaces/${ws}`, { cookie: joiner.cookie })).status).toBe(200);
    expect(await pendingIds(ws, owner.cookie)).toHaveLength(0);
    expect((await lookup(tokenOf(created))).status).toBe(404);
    const actions = await listAuditActions(h.deps.db, ws);
    expect(actions.filter((a) => a === 'invitation.accepted')).toHaveLength(1);
    expect(actions).toContain('member.added');
  });

  it('lets an existing member accept without changing the role', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('already-in');
    const created = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    // The address joined another way while the invitation was pending.
    const joiner = await h.createUser(email);
    await seedMembership(h.deps.db, ws, joiner.id, 'admin');
    const addedBefore = (await listAuditActions(h.deps.db, ws)).filter(
      (a) => a === 'member.added',
    ).length;
    const res = await accept(tokenOf(created), joiner.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workspaceId: ws, role: 'admin' });
    const { rows } = await h.harness.ownerPool.query(
      'SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2',
      [ws, joiner.id],
    );
    expect(rows).toEqual([{ role: 'admin' }]);
    const actions = await listAuditActions(h.deps.db, ws);
    expect(actions.filter((a) => a === 'member.added')).toHaveLength(addedBefore);
    expect(actions).toContain('invitation.accepted');
    expect(await pendingIds(ws, owner.cookie)).toHaveLength(0);
    expect((await lookup(tokenOf(created))).status).toBe(404);
  });

  it('refuses acceptance with an unverified email when SMTP is configured', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('unverified');
    const created = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    const joiner = await h.createUser(email);
    await h.harness.ownerPool.query('UPDATE auth_user SET email_verified = false WHERE id = $1', [
      joiner.id,
    ]);
    const res = await accept(tokenOf(created), joiner.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ detail: 'email_not_verified' });
    expect(await pendingIds(ws, owner.cookie)).toContain(created.invitation.id);
  });

  it('refuses to accept an invitation of a personal workspace', async () => {
    const owner = await h.createUser();
    const personal = owner.personalWorkspaceId ?? '';
    const email = uniqueEmail('into-personal');
    const { token, tokenHash } = newInvitationToken();
    // Creation refuses this; the row stands for one made before that rule.
    await seedInvitation(h.deps.db, {
      workspaceId: personal,
      email,
      tokenHash,
      invitedBy: owner.id,
      expiresAt: new Date(clock.now().getTime() + INVITATION_TTL_MS),
    });
    const joiner = await h.createUser(email);
    const res = await accept(token, joiner.cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ detail: 'personal_workspace' });
    const { rows } = await h.harness.ownerPool.query(
      'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2',
      [personal, joiner.id],
    );
    expect(rows).toHaveLength(0);
    expect(await listAuditActions(h.deps.db, personal)).not.toContain('invitation.accepted');
  });

  it('refuses acceptance by a different account', async () => {
    const { ws, owner } = await setup();
    const created = (await (
      await invite(ws, { email: uniqueEmail('target') }, owner.cookie)
    ).json()) as Created;
    const stranger = await h.createUser();
    const res = await accept(tokenOf(created), stranger.cookie);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ detail: 'email_mismatch' });
    expect((await h.request(`/api/workspaces/${ws}`, { cookie: stranger.cookie })).status).toBe(
      404,
    );
  });

  it('requires a session to accept and answers 404 for unknown tokens', async () => {
    expect(
      (await h.request('/api/invitations/accept', { body: { token: 'ow_inv_unknown_unknown' } }))
        .status,
    ).toBe(401);
    const u = await h.createUser();
    expect((await accept('ow_inv_unknown_unknown', u.cookie)).status).toBe(404);
    expect((await lookup('ow_inv_unknown_unknown')).status).toBe(404);
  });

  it('answers 404 for invitations of a deleted workspace', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('deleted');
    const created = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    const joiner = await h.createUser(email);
    expect(
      (await h.request(`/api/workspaces/${ws}`, { method: 'DELETE', cookie: owner.cookie })).status,
    ).toBe(204);
    expect((await lookup(tokenOf(created))).status).toBe(404);
    expect((await accept(tokenOf(created), joiner.cookie)).status).toBe(404);
  });

  it('does not let an acceptance join a workspace deleted while it waited', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('racing');
    const created = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    const joiner = await h.createUser(email);
    const res = await lock(
      ws,
      { sql: 'UPDATE workspaces SET deleted_at = now() WHERE id = $1', params: [ws] },
      () => accept(tokenOf(created), joiner.cookie),
    );
    expect(res.status).toBe(404);
    const { rows } = await h.harness.ownerPool.query(
      'SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2',
      [ws, joiner.id],
    );
    expect(rows).toHaveLength(0);
    expect(await listAuditActions(h.deps.db, ws)).not.toContain('invitation.accepted');
  });

  it('refuses an invitation by an admin demoted while the request waited', async () => {
    const { ws, owner } = await setup();
    const admin = await h.createUser();
    await seedMembership(h.deps.db, ws, admin.id, 'admin');
    const res = await lock(ws, setRole(ws, admin.id, 'member'), () =>
      invite(ws, { email: uniqueEmail('late-admin') }, admin.cookie),
    );
    expect(res.status).toBe(403);
    expect(await pendingIds(ws, owner.cookie)).toHaveLength(0);
  });

  it('refuses a cancellation by an admin demoted while the request waited', async () => {
    const { ws, owner } = await setup();
    const admin = await h.createUser();
    await seedMembership(h.deps.db, ws, admin.id, 'admin');
    const created = (await (
      await invite(ws, { email: uniqueEmail('kept') }, owner.cookie)
    ).json()) as Created;
    const res = await lock(ws, setRole(ws, admin.id, 'member'), () =>
      h.request(`/api/workspaces/${ws}/invitations/${created.invitation.id}`, {
        method: 'DELETE',
        cookie: admin.cookie,
      }),
    );
    expect(res.status).toBe(403);
    expect(await pendingIds(ws, owner.cookie)).toContain(created.invitation.id);
  });

  it('revokes an invitation', async () => {
    const { ws, owner } = await setup();
    const created = (await (
      await invite(ws, { email: uniqueEmail('revoked') }, owner.cookie)
    ).json()) as Created;
    const del = await h.request(`/api/workspaces/${ws}/invitations/${created.invitation.id}`, {
      method: 'DELETE',
      cookie: owner.cookie,
    });
    expect(del.status).toBe(204);
    expect((await lookup(tokenOf(created))).status).toBe(404);
    expect(
      (
        await h.request(`/api/workspaces/${ws}/invitations/${created.invitation.id}`, {
          method: 'DELETE',
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await h.request(`/api/workspaces/${ws}/invitations/not-a-uuid`, {
          method: 'DELETE',
          cookie: owner.cookie,
        })
      ).status,
    ).toBe(422);
    expect(await listAuditActions(h.deps.db, ws)).toContain('invitation.revoked');
  });

  // Moving the shared clock only expires invitations made earlier; every test makes its own.
  it('expires invitations after seven days', async () => {
    const { ws, owner } = await setup();
    const email = uniqueEmail('late');
    const created = (await (await invite(ws, { email }, owner.cookie)).json()) as Created;
    const late = await h.createUser(email);
    clock.advance(7 * 24 * 60 * 60 * 1000 + 1);
    expect((await lookup(tokenOf(created))).status).toBe(404);
    expect((await accept(tokenOf(created), late.cookie)).status).toBe(404);
    expect(await pendingIds(ws, owner.cookie)).toHaveLength(0);
  });
});

describe('management api: invitations with a failing smtp server', () => {
  let h: AuthHarness;
  const lines: string[] = [];
  beforeAll(async () => {
    h = await createAuthHarness({
      logger: createLogger('debug', { write: (line: string) => void lines.push(line) }),
      mailer: {
        async send(msg) {
          if (msg.to.startsWith('refused-')) throw new MailMessageError('refused');
          if (msg.subject.includes('invited')) throw new Error('smtp down');
        },
      },
    });
  });
  afterAll(async () => {
    await h.close();
  });

  it('still creates the invitation and returns the accept link', async () => {
    const owner = await h.createUser();
    const ws = await seedCommunityWorkspace(h.deps.db, owner.id);
    const res = await h.request(`/api/workspaces/${ws}/invitations`, {
      body: { email: uniqueEmail('down'), locale: 'en' },
      cookie: owner.cookie,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    expect(body.emailSent).toBe(false);
    expect(body.acceptUrl).toContain('/invite/ow_inv_');
  });

  it('logs a failed invitation email without the token, link or address', async () => {
    const owner = await h.createUser();
    const ws = await seedCommunityWorkspace(h.deps.db, owner.id);
    const email = uniqueEmail('quiet');
    const from = lines.length;
    const res = await h.request(`/api/workspaces/${ws}/invitations`, {
      body: { email, locale: 'en' },
      cookie: owner.cookie,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Created;
    const logged = lines.slice(from).filter((l) => l.includes('invitation email not sent'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0] ?? '{}')).toMatchObject({
      reason: 'transport',
      workspaceId: ws,
      invitationId: body.invitation.id,
    });
    for (const line of lines.slice(from)) {
      expect(line).not.toContain('ow_inv_');
      expect(line).not.toContain(tokenOf(body));
      expect(line.toLowerCase()).not.toContain(email.toLowerCase());
    }
  });

  it('reports a message the mailer refuses as not sent', async () => {
    const owner = await h.createUser();
    const ws = await seedCommunityWorkspace(h.deps.db, owner.id);
    const res = await h.request(`/api/workspaces/${ws}/invitations`, {
      body: { email: uniqueEmail('refused') },
      cookie: owner.cookie,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Created).emailSent).toBe(false);
  });
});

describe('management api: invitations without smtp', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({ smtp: false });
  });
  afterAll(async () => {
    await h.close();
  });

  it('returns the link without sending and allows acceptance without verification', async () => {
    const owner = await h.createUser();
    const ws = await seedCommunityWorkspace(h.deps.db, owner.id);
    const email = uniqueEmail('nosmtp');
    const created = (await (
      await h.request(`/api/workspaces/${ws}/invitations`, {
        body: { email },
        cookie: owner.cookie,
      })
    ).json()) as Created;
    expect(created.emailSent).toBe(false);
    const joiner = await h.createUser(email);
    const res = await h.request('/api/invitations/accept', {
      body: { token: tokenOf(created) },
      cookie: joiner.cookie,
    });
    expect(res.status).toBe(200);
  });
});

describe('management api: invitations while registration is closed', () => {
  let h: AuthHarness;
  let owner: TestUser;
  let outsider: TestUser;
  let ws: string;
  beforeAll(async () => {
    h = await createAuthHarness();
    owner = await h.createUser();
    outsider = await h.createUser();
    ws = await seedCommunityWorkspace(h.deps.db, owner.id);
    await setRegistrationMode(h.deps, 'closed', SYSTEM_ACTOR);
  });
  afterAll(async () => {
    await h.close();
  });

  const invite = (email: string) =>
    h.request(`/api/workspaces/${ws}/invitations`, { body: { email }, cookie: owner.cookie });

  it('refuses to invite an address with no account, without storing or sending anything', async () => {
    const email = uniqueEmail('closed-nobody');
    const res = await invite(email.toUpperCase());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict', detail: 'registration_closed' });
    expect(h.mailer.outbox.some((m) => m.to === email)).toBe(false);
    const { rows } = await h.harness.ownerPool.query(
      'select 1 from invitations where workspace_id = $1 and email = $2',
      [ws, email],
    );
    expect(rows).toHaveLength(0);
  });

  it('still invites an existing account', async () => {
    const res = await invite(outsider.email);
    expect(res.status).toBe(201);
    expect(((await res.json()) as Created).emailSent).toBe(true);
  });
});
