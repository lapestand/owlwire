import { newId } from '@owlwire/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { pgErrorOf, RepoConflictError, RepoInputError, RepoNotFoundError } from '../errors.js';
import {
  SYSTEM,
  type SystemTx,
  type TenantTx,
  tenantScope,
  withSystem,
  withTenant,
} from '../scope.js';
import {
  countInstanceAdmins,
  findAuthUserByEmail,
  findAuthUserById,
  grantInstanceAdmin,
  markEmailVerified,
} from '../system/auth-users.js';
import { findInvitationByTokenHash, hasPendingInvitationForEmail } from '../system/invitations.js';
import { findPersonalWorkspaceByOwner, listMembershipsForUser } from '../system/memberships.js';
import { listAuditLog, SYSTEM_ACTOR } from './audit.js';
import { q } from './context.js';
import {
  createInvitation,
  deletePendingInvitationsForEmail,
  getInvitationForUpdate,
  listPendingInvitations,
  markInvitationAccepted,
  revokeInvitation,
} from './invitations.js';
import {
  addMembership,
  countOwners,
  getMembership,
  getMembershipContext,
  LAST_OWNER,
  listMembers,
  removeMembership,
  transferWorkspaceOwnership,
  updateMemberRole,
} from './memberships.js';
import {
  createWorkspace,
  lockWorkspaceForUpdate,
  softDeleteWorkspace,
  toWorkspaceSummary,
  updateWorkspace,
} from './workspaces.js';

const DAY = 24 * 60 * 60 * 1000;
const MALFORMED = 'not-a-uuid';
let env: DbTestEnv;

beforeAll(async () => {
  env = await setupDbTestEnv();
}, 120_000);
afterAll(async () => {
  await env?.stop();
});

const inTenant = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
  withTenant(env.db, tenantScope(workspaceId), fn);
const inSystem = <T>(fn: (s: SystemTx) => Promise<T>) => withSystem(env.db, SYSTEM, fn);
const as = (userId: string) => ({ kind: 'user' as const, userId });

async function user(email?: string): Promise<string> {
  const id = newId();
  await env.owner.query('insert into auth_user (id, name, email) values ($1, $2, $3)', [
    id,
    `User ${id.slice(-4)}`,
    email ?? `${id}@x.test`,
  ]);
  return id;
}

async function community(ownerUserId: string): Promise<string> {
  const id = newId();
  await inTenant(id, async (t) => {
    await createWorkspace(
      t,
      { name: 'Alliance', slug: `alliance-${id.slice(-12)}`, kind: 'community' },
      as(ownerUserId),
    );
    await addMembership(t, { userId: ownerUserId, role: 'owner', via: 'create' }, as(ownerUserId));
  });
  return id;
}

const actions = (workspaceId: string) =>
  inTenant(workspaceId, async (t) => (await listAuditLog(t, { limit: 200 })).map((r) => r.action));

const later = (days: number) => new Date(env.clock.now().getTime() + days * DAY);

/** Settles a promise into its value or error, so a test can assert on either without try/catch noise. */
const settle = <T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; err: unknown }> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (err: unknown) => ({ ok: false as const, err }),
  );

describe('memberships', () => {
  it('adds members idempotently, counts owners and audits member.added', async () => {
    const a = await user();
    const ws = await community(a);
    await inTenant(ws, async (t) => {
      expect(await addMembership(t, { userId: a, role: 'owner' }, as(a))).toBe(false);
      expect(await countOwners(t)).toBe(1);
      const added = await listAuditLog(t, { action: 'member.added' });
      expect(added).toHaveLength(1);
      expect(added[0]).toMatchObject({
        targetType: 'member',
        targetId: a,
        data: { role: 'owner', via: 'create' },
      });
    });
  });

  it('does not return a membership through another workspace scope', async () => {
    const a = await user();
    const b = await user();
    const wsA = await community(a);
    const wsB = await community(b);
    expect(await inTenant(wsB, (t) => getMembershipContext(t, a))).toBeNull();
    expect(await inTenant(wsB, (t) => getMembership(t, a))).toBeNull();
    const own = await inTenant(wsA, (t) => getMembershipContext(t, a));
    expect(own?.role).toBe('owner');
    expect(own?.workspace.id).toBe(wsA);
  });

  it('changes roles, removes members and audits both with the member target type', async () => {
    const a = await user();
    const b = await user();
    const ws = await community(a);
    await inTenant(ws, async (t) => {
      await addMembership(t, { userId: b, role: 'member' }, as(a));
      expect(await updateMemberRole(t, b, 'admin', as(a))).toBe(true);
      expect((await getMembership(t, b))?.role).toBe('admin');
      expect(await removeMembership(t, b, as(b))).toBe(true);
      expect(await removeMembership(t, b, as(b))).toBe(false);
      expect((await listMembers(t)).map((m) => m.userId)).toEqual([a]);
      const [changed] = await listAuditLog(t, { action: 'member.role_changed' });
      expect(changed).toMatchObject({
        targetType: 'member',
        targetId: b,
        data: { from: 'member', to: 'admin' },
      });
      const [removed] = await listAuditLog(t, { action: 'member.removed' });
      expect(removed).toMatchObject({ targetType: 'member', data: { role: 'admin', self: true } });
    });
  });

  it('treats a role change to the same role as a no-op without an audit row', async () => {
    const a = await user();
    const ws = await community(a);
    await inTenant(ws, async (t) => {
      expect(await updateMemberRole(t, a, 'owner', as(a))).toBe(true);
      expect(await listAuditLog(t, { action: 'member.role_changed' })).toEqual([]);
    });
  });

  it('lists members with name, email, role and join time', async () => {
    const a = await user();
    const ws = await community(a);
    const [member] = await inTenant(ws, (t) => listMembers(t));
    expect(member).toMatchObject({ userId: a, email: `${a}@x.test`, role: 'owner' });
    expect(member?.name).toBe(`User ${a.slice(-4)}`);
    expect(member?.joinedAt).toBeInstanceOf(Date);
  });

  it('refuses to demote or remove the last owner', async () => {
    const a = await user();
    const ws = await community(a);
    for (const attempt of [
      (t: TenantTx) => updateMemberRole(t, a, 'admin', as(a)),
      (t: TenantTx) => removeMembership(t, a, as(a)),
    ]) {
      const out = await settle(inTenant(ws, attempt));
      expect(out.ok).toBe(false);
      expect(out.ok ? null : out.err).toBeInstanceOf(RepoConflictError);
      expect(out.ok ? null : out.err).toMatchObject({
        entity: 'membership',
        constraint: LAST_OWNER,
      });
    }
    expect(await inTenant(ws, (t) => countOwners(t))).toBe(1);
    expect(await actions(ws)).not.toContain('member.removed');
  });

  it('lets one of two owners step down, but never both', async () => {
    const a = await user();
    const b = await user();
    const ws = await community(a);
    await inTenant(ws, (t) => addMembership(t, { userId: b, role: 'owner' }, as(a)));
    expect(await inTenant(ws, (t) => updateMemberRole(t, a, 'member', as(a)))).toBe(true);
    const out = await settle(inTenant(ws, (t) => removeMembership(t, b, as(b))));
    expect(out.ok ? null : out.err).toBeInstanceOf(RepoConflictError);
    expect(await inTenant(ws, (t) => countOwners(t))).toBe(1);
  });

  type Op = (t: TenantTx) => Promise<boolean>;
  interface Race {
    /** Members besides `a` (always an owner): b and c with these roles. */
    b: 'owner' | 'member';
    c: 'owner' | 'member' | null;
    first: (u: Users) => Op;
    second: (u: Users) => Op;
    /** What the blocked second call ends with once the first one commits. */
    secondOutcome: 'conflict' | false;
  }
  interface Users {
    a: string;
    b: string;
    c: string;
  }
  const RACES: Array<[string, Race]> = [
    [
      'two owner demotions',
      {
        b: 'owner',
        c: null,
        first: (u) => (t) => updateMemberRole(t, u.a, 'admin', as(u.a)),
        second: (u) => (t) => updateMemberRole(t, u.b, 'admin', as(u.b)),
        secondOutcome: 'conflict',
      },
    ],
    [
      'an owner removal against a demotion of the other owner',
      {
        b: 'owner',
        c: null,
        first: (u) => (t) => removeMembership(t, u.a, as(u.a)),
        second: (u) => (t) => updateMemberRole(t, u.b, 'member', as(u.b)),
        secondOutcome: 'conflict',
      },
    ],
    [
      'an owner demotion against a removal of the other owner',
      {
        b: 'owner',
        c: null,
        first: (u) => (t) => updateMemberRole(t, u.a, 'admin', as(u.a)),
        second: (u) => (t) => removeMembership(t, u.b, as(u.b)),
        secondOutcome: 'conflict',
      },
    ],
    [
      'a transfer against a demotion of the new owner',
      {
        b: 'member',
        c: null,
        first: (u) => (t) => transferWorkspaceOwnership(t, { from: u.a, to: u.b }, as(u.a)),
        second: (u) => (t) => updateMemberRole(t, u.b, 'member', as(u.b)),
        secondOutcome: 'conflict',
      },
    ],
    [
      'an owner demotion against a transfer away from that owner',
      {
        b: 'owner',
        c: 'member',
        first: (u) => (t) => updateMemberRole(t, u.a, 'admin', as(u.a)),
        second: (u) => (t) => transferWorkspaceOwnership(t, { from: u.a, to: u.c }, as(u.a)),
        secondOutcome: false,
      },
    ],
  ];

  it.each(RACES)(
    'serializes %s and never leaves the workspace without an owner',
    async (_name, race) => {
      const u: Users = { a: await user(), b: await user(), c: await user() };
      const ws = await community(u.a);
      await inTenant(ws, async (t) => {
        await addMembership(t, { userId: u.b, role: race.b }, as(u.a));
        if (race.c) await addMembership(t, { userId: u.c, role: race.c }, as(u.a));
      });

      let holding!: () => void;
      const held = new Promise<void>((resolve) => {
        holding = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // The first transaction runs its change and keeps its row locks until the gate opens.
      const first = settle(
        inTenant(ws, async (t) => {
          const value = await race.first(u)(t);
          holding();
          await gate;
          return value;
        }),
      );
      await held;

      // The second transaction reports its backend pid, then runs its change while the first is still open.
      let reportPid!: (pid: number) => void;
      const pid = new Promise<number>((resolve) => {
        reportPid = resolve;
      });
      const second = settle(
        inTenant(ws, async (t) => {
          const result = await q(t).execute(sql`select pg_backend_pid() as pid`);
          reportPid(Number((result.rows[0] as { pid: number }).pid));
          return race.second(u)(t);
        }),
      );
      let secondDone = false;
      void second.then(() => {
        secondDone = true;
      });

      // Observe exactly that backend waiting on a lock; give up if the second call finishes first.
      const secondPid = await pid;
      let observedBlocked = false;
      for (let i = 0; i < 400 && !secondDone; i++) {
        const { rows } = await env.owner.query(
          "select 1 from pg_stat_activity where pid = $1 and wait_event_type = 'Lock'",
          [secondPid],
        );
        if (rows.length > 0) {
          observedBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      release();

      const [one, two] = await Promise.all([first, second]);
      expect(observedBlocked, 'second transaction was seen waiting on the row lock').toBe(true);
      expect(one).toEqual({ ok: true, value: true });
      if (race.secondOutcome === 'conflict') {
        expect(two.ok).toBe(false);
        expect(two.ok ? null : two.err).toBeInstanceOf(RepoConflictError);
        expect(two.ok ? null : two.err).toMatchObject({
          entity: 'membership',
          constraint: LAST_OWNER,
        });
      } else {
        expect(two).toEqual({ ok: true, value: false });
      }
      expect(await inTenant(ws, (t) => countOwners(t))).toBe(1);
    },
  );

  it('transfers ownership with a single workspace audit entry', async () => {
    const a = await user();
    const b = await user();
    const ws = await community(a);
    await inTenant(ws, async (t) => {
      await addMembership(t, { userId: b, role: 'member' }, as(a));
      expect(await transferWorkspaceOwnership(t, { from: a, to: b }, as(a))).toBe(true);
      expect((await getMembership(t, a))?.role).toBe('admin');
      expect((await getMembership(t, b))?.role).toBe('owner');
      const entries = await listAuditLog(t, { action: 'workspace.ownership_transferred' });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        targetType: 'workspace',
        targetId: ws,
        data: { from: a, to: b },
      });
      expect(await listAuditLog(t, { action: 'member.role_changed' })).toEqual([]);
    });
  });

  it('does not transfer ownership to a non-member, from a non-owner or to the same user', async () => {
    const a = await user();
    const b = await user();
    const outsider = await user();
    const ws = await community(a);
    await inTenant(ws, (t) => addMembership(t, { userId: b, role: 'member' }, as(a)));
    expect(
      await inTenant(ws, (t) => transferWorkspaceOwnership(t, { from: a, to: outsider }, as(a))),
    ).toBe(false);
    expect(
      await inTenant(ws, (t) => transferWorkspaceOwnership(t, { from: b, to: a }, as(b))),
    ).toBe(false);
    const same = await settle(
      inTenant(ws, (t) => transferWorkspaceOwnership(t, { from: a, to: a }, as(a))),
    );
    expect(same.ok ? null : same.err).toBeInstanceOf(RepoInputError);
    expect(await actions(ws)).not.toContain('workspace.ownership_transferred');
    expect((await inTenant(ws, (t) => getMembership(t, a)))?.role).toBe('owner');
    expect((await inTenant(ws, (t) => getMembership(t, b)))?.role).toBe('member');
  });

  it('rejects unknown and malformed user ids', async () => {
    const a = await user();
    const ws = await community(a);
    const unknown = await settle(
      inTenant(ws, (t) => addMembership(t, { userId: newId(), role: 'member' }, as(a))),
    );
    expect(unknown.ok ? null : unknown.err).toBeInstanceOf(RepoNotFoundError);
    expect(unknown.ok ? null : unknown.err).toMatchObject({ entity: 'user' });
    const malformed = await settle(
      inTenant(ws, (t) => addMembership(t, { userId: MALFORMED, role: 'member' }, as(a))),
    );
    expect(malformed.ok ? null : malformed.err).toBeInstanceOf(RepoInputError);
    await inTenant(ws, async (t) => {
      expect(await getMembership(t, MALFORMED)).toBeNull();
      expect(await getMembershipContext(t, MALFORMED)).toBeNull();
      expect(await updateMemberRole(t, MALFORMED, 'admin', as(a))).toBe(false);
      expect(await removeMembership(t, MALFORMED, as(a))).toBe(false);
      expect(await transferWorkspaceOwnership(t, { from: a, to: MALFORMED }, as(a))).toBe(false);
    });
  });

  it('lists workspaces for a user and skips soft-deleted ones', async () => {
    const a = await user();
    const ws1 = await community(a);
    const ws2 = await community(a);
    expect(await inTenant(ws2, (t) => softDeleteWorkspace(t, as(a)))).toBe(true);
    expect(await inTenant(ws2, (t) => softDeleteWorkspace(t, as(a)))).toBe(false);
    expect(await inTenant(ws2, (t) => lockWorkspaceForUpdate(t))).toBeNull();
    expect(await inTenant(ws2, (t) => getMembershipContext(t, a))).toBeNull();
    expect(await actions(ws2)).toContain('workspace.deleted');
    const list = await inSystem((s) => listMembershipsForUser(s, a));
    expect(list.map((m) => m.workspace.id)).toEqual([ws1]);
    expect(list[0]?.role).toBe('owner');
    expect(await inSystem((s) => listMembershipsForUser(s, MALFORMED))).toEqual([]);
  });
});

describe('workspaces', () => {
  it('creates a personal workspace only once per owner', async () => {
    const a = await user();
    const slug = `p-${a.replace(/-/g, '')}`;
    const first = newId();
    await inTenant(first, (t) =>
      createWorkspace(t, { name: 'Mine', slug, kind: 'personal', ownerUserId: a }, as(a)),
    );
    const second = newId();
    await expect(
      inTenant(second, (t) =>
        createWorkspace(
          t,
          { name: 'Mine', slug: `${slug.slice(0, 30)}x`, kind: 'personal', ownerUserId: a },
          as(a),
        ),
      ),
    ).rejects.toBeInstanceOf(RepoConflictError);
    const found = await inSystem((s) => findPersonalWorkspaceByOwner(s, a));
    expect(found).toMatchObject({ id: first, kind: 'personal', ownerUserId: a });
    expect(await inSystem((s) => findPersonalWorkspaceByOwner(s, MALFORMED))).toBeNull();
  });

  it('rejects an owner on a community workspace, a malformed owner and an unknown owner', async () => {
    const a = await user();
    const attempt = (input: { kind: 'personal' | 'community'; ownerUserId: string }) => {
      const id = newId();
      return settle(
        inTenant(id, (t) =>
          createWorkspace(t, { name: 'Bad', slug: `bad-${id.slice(-12)}`, ...input }, as(a)),
        ),
      );
    };
    const owned = await attempt({ kind: 'community', ownerUserId: a });
    expect(owned.ok ? null : owned.err).toBeInstanceOf(RepoInputError);
    const malformed = await attempt({ kind: 'personal', ownerUserId: MALFORMED });
    expect(malformed.ok ? null : malformed.err).toBeInstanceOf(RepoInputError);
    const unknownId = newId();
    const unknown = await attempt({ kind: 'personal', ownerUserId: unknownId });
    expect(unknown.ok ? null : unknown.err).toBeInstanceOf(RepoNotFoundError);
    expect(unknown.ok ? null : unknown.err).toMatchObject({ entity: 'user', id: unknownId });
    expect(pgErrorOf(owned.ok ? null : owned.err)).toBeNull();
  });

  it('updates name and slug, reports slug conflicts and audits workspace.updated', async () => {
    const a = await user();
    const ws1 = await community(a);
    const ws2 = await community(a);
    const taken = (await inTenant(ws1, (t) => lockWorkspaceForUpdate(t)))?.slug ?? '';
    await expect(
      inTenant(ws2, (t) => updateWorkspace(t, { slug: taken }, as(a))),
    ).rejects.toBeInstanceOf(RepoConflictError);
    const renamed = await inTenant(ws2, (t) => updateWorkspace(t, { name: 'Renamed' }, as(a)));
    expect(renamed?.name).toBe('Renamed');
    const [updated] = await inTenant(ws2, (t) => listAuditLog(t, { action: 'workspace.updated' }));
    expect(updated).toMatchObject({
      targetType: 'workspace',
      targetId: ws2,
      data: { name: 'Renamed' },
    });
  });

  it('treats an empty patch as a read and does not update a deleted workspace', async () => {
    const a = await user();
    const ws = await community(a);
    const same = await inTenant(ws, (t) => updateWorkspace(t, {}, as(a)));
    expect(same).toMatchObject({ id: ws, name: 'Alliance' });
    expect(await actions(ws)).not.toContain('workspace.updated');
    await inTenant(ws, (t) => softDeleteWorkspace(t, as(a)));
    expect(await inTenant(ws, (t) => updateWorkspace(t, { name: 'Gone' }, as(a)))).toBeNull();
    expect(await inTenant(ws, (t) => updateWorkspace(t, {}, as(a)))).toBeNull();
    expect(await actions(ws)).not.toContain('workspace.updated');
  });

  it('maps a workspace row to its summary', async () => {
    const a = await user();
    const id = newId();
    const row = await inTenant(id, (t) =>
      createWorkspace(
        t,
        { name: 'Mine', slug: `p-${id.slice(-12)}`, kind: 'personal', ownerUserId: a },
        as(a),
      ),
    );
    expect(toWorkspaceSummary(row)).toEqual({
      id,
      name: 'Mine',
      slug: `p-${id.slice(-12)}`,
      kind: 'personal',
      ownerUserId: a,
      createdAt: row.createdAt,
    });
  });
});

describe('invitations', () => {
  it('tracks pending invitations by email through expiry and acceptance', async () => {
    const a = await user();
    const ws = await community(a);
    const email = `invitee-${newId()}@x.test`;
    const tokenHash = `hash-${newId()}`;
    const inv = await inTenant(ws, (t) =>
      createInvitation(
        t,
        {
          email: email.toUpperCase(),
          role: 'member',
          tokenHash,
          invitedBy: a,
          expiresAt: later(7),
        },
        as(a),
      ),
    );
    expect(inv.email).toBe(email);
    expect(await inSystem((s) => hasPendingInvitationForEmail(s, email.toUpperCase()))).toBe(true);
    const start = env.clock.now();
    env.clock.set(new Date(start.getTime() + 8 * DAY));
    try {
      expect(await inSystem((s) => hasPendingInvitationForEmail(s, email))).toBe(false);
      expect(await inTenant(ws, (t) => listPendingInvitations(t))).toEqual([]);
    } finally {
      env.clock.set(start);
    }
    const lookup = await inSystem((s) => findInvitationByTokenHash(s, tokenHash));
    expect(lookup).toMatchObject({ id: inv.id, workspaceName: 'Alliance', email });
    await inTenant(ws, async (t) => {
      expect((await getInvitationForUpdate(t, inv.id))?.acceptedAt).toBeNull();
      expect(await markInvitationAccepted(t, inv.id, as(a))).toBe(true);
      expect(await markInvitationAccepted(t, inv.id, as(a))).toBe(false);
      expect(await revokeInvitation(t, inv.id, as(a))).toBe(false);
    });
    expect(await inSystem((s) => hasPendingInvitationForEmail(s, email))).toBe(false);
    expect(await actions(ws)).toEqual(
      expect.arrayContaining(['invitation.created', 'invitation.accepted']),
    );
    const [created] = await inTenant(ws, (t) => listAuditLog(t, { action: 'invitation.created' }));
    expect(created).toMatchObject({ targetType: 'invitation', targetId: inv.id });
    expect(JSON.stringify(created?.data)).not.toContain(tokenHash);
  });

  it('refuses to accept an invitation once the clock has passed its expiry, but still revokes it', async () => {
    const a = await user();
    const ws = await community(a);
    const tokenHash = `late-${newId()}`;
    const inv = await inTenant(ws, (t) =>
      createInvitation(
        t,
        {
          email: `late-${newId()}@x.test`,
          role: 'member',
          tokenHash,
          invitedBy: a,
          expiresAt: later(1),
        },
        as(a),
      ),
    );
    const start = env.clock.now();
    env.clock.set(new Date(start.getTime() + 2 * DAY));
    try {
      // The lookup still finds it (callers report "expired"), but the state change refuses it.
      const found = await inSystem((s) => findInvitationByTokenHash(s, tokenHash));
      expect(found?.id).toBe(inv.id);
      expect(found && found.expiresAt.getTime() < env.clock.now().getTime()).toBe(true);
      await inTenant(ws, async (t) => {
        expect(await markInvitationAccepted(t, inv.id, as(a))).toBe(false);
        expect((await getInvitationForUpdate(t, inv.id))?.acceptedAt).toBeNull();
      });
      expect(await actions(ws)).not.toContain('invitation.accepted');
      expect(await inTenant(ws, (t) => revokeInvitation(t, inv.id, as(a)))).toBe(true);
    } finally {
      env.clock.set(start);
    }
  });

  it('never hands out the token hash', async () => {
    const a = await user();
    const ws = await community(a);
    const tokenHash = `secret-hash-${newId()}`;
    const created = await inTenant(ws, (t) =>
      createInvitation(
        t,
        {
          email: `hash-${newId()}@x.test`,
          role: 'admin',
          tokenHash,
          invitedBy: a,
          expiresAt: later(1),
        },
        as(a),
      ),
    );
    const listed = await inTenant(ws, (t) => listPendingInvitations(t));
    const locked = await inTenant(ws, (t) => getInvitationForUpdate(t, created.id));
    const lookup = await inSystem((s) => findInvitationByTokenHash(s, tokenHash));
    expect(lookup?.id).toBe(created.id);
    for (const row of [created, ...listed, locked, lookup]) {
      expect(row).not.toBeNull();
      expect(Object.keys(row ?? {})).not.toContain('tokenHash');
      expect(JSON.stringify(row)).not.toContain(tokenHash);
    }
  });

  it('replaces pending invitations for an email and revokes by id', async () => {
    const a = await user();
    const ws = await community(a);
    const email = `dup-${newId()}@x.test`;
    await inTenant(ws, async (t) => {
      const input = { email, role: 'member' as const, invitedBy: a, expiresAt: later(1) };
      await createInvitation(t, { ...input, tokenHash: `h-${newId()}` }, as(a));
      expect(await deletePendingInvitationsForEmail(t, email.toUpperCase(), as(a))).toBe(1);
      expect(await listPendingInvitations(t)).toHaveLength(0);
      const second = await createInvitation(t, { ...input, tokenHash: `h-${newId()}` }, as(a));
      expect((await listPendingInvitations(t)).map((i) => i.id)).toEqual([second.id]);
      expect(await revokeInvitation(t, second.id, as(a))).toBe(true);
      expect(await revokeInvitation(t, second.id, as(a))).toBe(false);
      const revoked = await listAuditLog(t, { action: 'invitation.revoked' });
      expect(revoked.map((r) => (r.data as { reason: string }).reason).sort()).toEqual([
        'replaced',
        'revoked',
      ]);
    });
  });

  it('allows one open invitation per email and workspace', async () => {
    const a = await user();
    const ws = await community(a);
    const email = `once-${newId()}@x.test`;
    const input = { email, role: 'admin' as const, invitedBy: a, expiresAt: later(1) };
    await inTenant(ws, (t) => createInvitation(t, { ...input, tokenHash: `h-${newId()}` }, as(a)));
    const again = await settle(
      inTenant(ws, (t) => createInvitation(t, { ...input, tokenHash: `h-${newId()}` }, as(a))),
    );
    expect(again.ok ? null : again.err).toBeInstanceOf(RepoConflictError);
    expect(again.ok ? null : again.err).toMatchObject({
      entity: 'invitation',
      constraint: 'invitations_pending_email_uidx',
    });
  });

  it('rejects unknown and malformed inviters and answers malformed ids like unknown ones', async () => {
    const a = await user();
    const ws = await community(a);
    const base = { email: `who-${newId()}@x.test`, role: 'member' as const, expiresAt: later(1) };
    const unknownId = newId();
    const unknown = await settle(
      inTenant(ws, (t) =>
        createInvitation(t, { ...base, tokenHash: `h-${newId()}`, invitedBy: unknownId }, as(a)),
      ),
    );
    expect(unknown.ok ? null : unknown.err).toBeInstanceOf(RepoNotFoundError);
    expect(unknown.ok ? null : unknown.err).toMatchObject({ entity: 'user', id: unknownId });
    const malformed = await settle(
      inTenant(ws, (t) =>
        createInvitation(t, { ...base, tokenHash: `h-${newId()}`, invitedBy: MALFORMED }, as(a)),
      ),
    );
    expect(malformed.ok ? null : malformed.err).toBeInstanceOf(RepoInputError);
    const noInviter = await inTenant(ws, (t) =>
      createInvitation(t, { ...base, tokenHash: `h-${newId()}`, invitedBy: null }, as(a)),
    );
    expect(noInviter.invitedBy).toBeNull();
    await inTenant(ws, async (t) => {
      expect(await getInvitationForUpdate(t, MALFORMED)).toBeNull();
      expect(await revokeInvitation(t, MALFORMED, as(a))).toBe(false);
      expect(await markInvitationAccepted(t, MALFORMED, as(a))).toBe(false);
    });
  });

  it('hides invitations of soft-deleted workspaces from token and email lookups', async () => {
    const a = await user();
    const ws = await community(a);
    const tokenHash = `gone-${newId()}`;
    const email = `g-${newId()}@x.test`;
    await inTenant(ws, async (t) => {
      await createInvitation(
        t,
        { email, role: 'member', tokenHash, invitedBy: a, expiresAt: later(1) },
        as(a),
      );
      await softDeleteWorkspace(t, as(a));
    });
    expect(await inSystem((s) => findInvitationByTokenHash(s, tokenHash))).toBeNull();
    expect(await inSystem((s) => hasPendingInvitationForEmail(s, email))).toBe(false);
  });
});

describe('auth users', () => {
  // auth_user flags and writes are reachable only through the auth role.
  const asAuthRole = <T>(fn: (s: SystemTx) => Promise<T>) => withSystem(env.authDb, SYSTEM, fn);

  it('keeps the auth_user system functions away from the application role', async () => {
    const id = await user(`app-${newId()}@x.test`);
    await expect(inSystem((s) => findAuthUserById(s, id))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
    await expect(inSystem((s) => markEmailVerified(s, id))).rejects.toMatchObject({
      cause: { code: '42501' },
    });
  });

  it('finds users case-insensitively and grants the instance admin flag once', async () => {
    const email = `admin-${newId()}@x.test`;
    const id = await user(email);
    await asAuthRole(async (s) => {
      expect((await findAuthUserByEmail(s, ` ${email.toUpperCase()} `))?.id).toBe(id);
      const before = await countInstanceAdmins(s);
      expect(await grantInstanceAdmin(s, id, SYSTEM_ACTOR)).toBe(true);
      expect(await grantInstanceAdmin(s, id, SYSTEM_ACTOR)).toBe(false);
      await markEmailVerified(s, id);
      expect(await countInstanceAdmins(s)).toBe(before + 1);
      expect(await findAuthUserById(s, id)).toEqual({
        id,
        email,
        name: `User ${id.slice(-4)}`,
        image: null,
        emailVerified: true,
        isInstanceAdmin: true,
        twoFactorEnabled: false,
      });
    });
    const { rows } = await env.owner.query(
      "select workspace_id, target_type from audit_log where action = 'instance.admin_granted' and target_id = $1",
      [id],
    );
    expect(rows).toEqual([{ workspace_id: null, target_type: 'instance' }]);
  });

  it('answers malformed and unknown user ids without SQL errors', async () => {
    await asAuthRole(async (s) => {
      expect(await findAuthUserById(s, MALFORMED)).toBeNull();
      expect(await findAuthUserById(s, newId())).toBeNull();
      expect(await findAuthUserByEmail(s, `nobody-${newId()}@x.test`)).toBeNull();
      expect(await grantInstanceAdmin(s, MALFORMED, SYSTEM_ACTOR)).toBe(false);
      expect(await grantInstanceAdmin(s, newId(), SYSTEM_ACTOR)).toBe(false);
      await markEmailVerified(s, MALFORMED);
    });
  });
});
