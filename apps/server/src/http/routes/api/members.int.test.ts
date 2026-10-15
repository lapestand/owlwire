import { listAuditActions, seedCommunityWorkspace, seedMembership } from '@owlwire/db/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AuthHarness, createAuthHarness, type TestUser } from '../../../test/auth-harness.js';
import { waitFor } from '../../../test/wait.js';

interface MemberDto {
  userId: string;
  name: string;
  email: string;
  role: 'owner' | 'admin' | 'member';
  joinedAt: string;
}
interface AuditItem {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actor: { type: string; id: string | null; name: string | null };
  data: Record<string, unknown>;
  createdAt: string;
}
interface AuditPage {
  items: AuditItem[];
  nextCursor: string | null;
}

describe('management api: members', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function team(): Promise<{
    ws: string;
    owner: TestUser;
    admin: TestUser;
    member: TestUser;
  }> {
    const owner = await h.createUser();
    const admin = await h.createUser();
    const member = await h.createUser();
    const ws = await seedCommunityWorkspace(h.deps.db, owner.id);
    await seedMembership(h.deps.db, ws, admin.id, 'admin');
    await seedMembership(h.deps.db, ws, member.id, 'member');
    return { ws, owner, admin, member };
  }

  const patchRole = (ws: string, userId: string, role: string, cookie: string) =>
    h.request(`/api/workspaces/${ws}/members/${userId}`, {
      method: 'PATCH',
      body: { role },
      cookie,
    });
  const remove = (ws: string, userId: string, cookie: string) =>
    h.request(`/api/workspaces/${ws}/members/${userId}`, { method: 'DELETE', cookie });
  const transfer = (ws: string, userId: string, cookie: string) =>
    h.request(`/api/workspaces/${ws}/transfer-ownership`, { body: { userId }, cookie });
  const members = async (ws: string, cookie: string) =>
    (
      (await (await h.request(`/api/workspaces/${ws}/members`, { cookie })).json()) as {
        items: MemberDto[];
      }
    ).items;
  const roleOf = async (ws: string, userId: string, cookie: string) =>
    (await members(ws, cookie)).find((m) => m.userId === userId)?.role;
  const audit = async (ws: string, query: string, cookie: string) =>
    (await (
      await h.request(`/api/workspaces/${ws}/audit${query}`, { cookie })
    ).json()) as AuditPage;
  const count = (actions: string[], action: string) => actions.filter((a) => a === action).length;

  /**
   * Runs `fire` while another transaction holds the workspace row lock and has already made `change` (not yet
   * committed). The request passes the access check on the committed state, then waits for the lock; the change is
   * committed only once the request is seen waiting on it, so the write must decide on the state after the change.
   */
  async function underWorkspaceLock(
    ws: string,
    change: { sql: string; params: unknown[] },
    fire: () => Promise<Response>,
  ): Promise<Response> {
    const pool = h.harness.ownerPool;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [ws]);
      await client.query(change.sql, change.params);
      const { rows } = await client.query<{ xid: string }>(
        'SELECT pg_current_xact_id()::text AS xid',
      );
      const xid = rows[0]?.xid ?? '';
      const pending = fire();
      await waitFor(
        async () => {
          const waiting = await pool.query(
            `SELECT 1 FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1`,
            [xid],
          );
          return (waiting.rowCount ?? 0) > 0;
        },
        10_000,
        20,
      );
      await client.query('COMMIT');
      return await pending;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }
  const setRole = (ws: string, userId: string, role: string) => ({
    sql: 'UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
    params: [ws, userId, role],
  });
  const dropMember = (ws: string, userId: string) => ({
    sql: 'DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2',
    params: [ws, userId],
  });

  it('lists members for any member', async () => {
    const t = await team();
    const items = await members(t.ws, t.member.cookie);
    expect(items.map((m) => m.role).sort()).toEqual(['admin', 'member', 'owner']);
  });

  it('exposes only the member fields of the contract', async () => {
    const t = await team();
    const items = await members(t.ws, t.member.cookie);
    const owner = items.find((m) => m.userId === t.owner.id);
    expect(owner).toEqual({
      userId: t.owner.id,
      name: t.owner.name,
      email: t.owner.email,
      role: 'owner',
      joinedAt: expect.any(String),
    });
    for (const item of items)
      expect(Object.keys(item).sort()).toEqual(['email', 'joinedAt', 'name', 'role', 'userId']);
  });

  it('applies the role change matrix', async () => {
    const t = await team();
    expect((await patchRole(t.ws, t.member.id, 'admin', t.member.cookie)).status).toBe(403);
    expect((await patchRole(t.ws, t.member.id, 'owner', t.admin.cookie)).status).toBe(403);
    const promoted = await patchRole(t.ws, t.member.id, 'admin', t.admin.cookie);
    expect(promoted.status).toBe(200);
    expect(await promoted.json()).toMatchObject({ userId: t.member.id, role: 'admin' });
    expect((await patchRole(t.ws, t.member.id, 'owner', t.owner.cookie)).status).toBe(200);
    expect(await listAuditActions(h.deps.db, t.ws)).toContain('member.role_changed');
  });

  it('refuses to demote the last owner', async () => {
    const t = await team();
    const res = await patchRole(t.ws, t.owner.id, 'admin', t.owner.cookie);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict', detail: 'last_owner' });
  });

  it('answers a change to the current role like the change itself, without an audit entry', async () => {
    const t = await team();
    const before = count(await listAuditActions(h.deps.db, t.ws), 'member.role_changed');
    const same = await patchRole(t.ws, t.admin.id, 'admin', t.owner.cookie);
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ userId: t.admin.id, role: 'admin' });
    // owner -> owner by the only owner: allowed (nothing is demoted), not last_owner
    expect((await patchRole(t.ws, t.owner.id, 'owner', t.owner.cookie)).status).toBe(200);
    // the same no-op still needs the role the real change would need
    expect((await patchRole(t.ws, t.owner.id, 'owner', t.admin.cookie)).status).toBe(403);
    expect((await patchRole(t.ws, t.member.id, 'member', t.member.cookie)).status).toBe(403);
    expect(count(await listAuditActions(h.deps.db, t.ws), 'member.role_changed')).toBe(before);
  });

  it('lets an admin demote a peer admin but not touch owners', async () => {
    const t = await team();
    const peer = await h.createUser();
    await seedMembership(h.deps.db, t.ws, peer.id, 'admin');
    const res = await patchRole(t.ws, peer.id, 'member', t.admin.cookie);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ userId: peer.id, role: 'member' });
    expect((await patchRole(t.ws, t.owner.id, 'admin', t.admin.cookie)).status).toBe(403);
    // an admin may step down themselves
    expect((await patchRole(t.ws, t.admin.id, 'member', t.admin.cookie)).status).toBe(200);
    expect((await patchRole(t.ws, peer.id, 'admin', t.admin.cookie)).status).toBe(403);
  });

  it('keeps the owner of a personal workspace fixed', async () => {
    const owner = await h.createUser();
    const guest = await h.createUser();
    const personal = owner.personalWorkspaceId ?? '';
    await seedMembership(h.deps.db, personal, guest.id, 'member');
    for (const res of [
      await patchRole(personal, owner.id, 'admin', owner.cookie),
      await patchRole(personal, owner.id, 'owner', owner.cookie),
      await patchRole(personal, guest.id, 'owner', owner.cookie),
      await remove(personal, owner.id, owner.cookie),
    ]) {
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'conflict', detail: 'personal_workspace' });
    }
    expect(await roleOf(personal, owner.id, owner.cookie)).toBe('owner');
    expect(await roleOf(personal, guest.id, owner.cookie)).toBe('member');
  });

  it('validates the role value', async () => {
    const t = await team();
    expect((await patchRole(t.ws, t.member.id, 'root', t.owner.cookie)).status).toBe(422);
  });

  it('answers 404 for non-members and 422 for malformed member ids', async () => {
    const t = await team();
    const outsider = await h.createUser();
    expect((await patchRole(t.ws, outsider.id, 'admin', t.owner.cookie)).status).toBe(404);
    expect((await remove(t.ws, outsider.id, t.owner.cookie)).status).toBe(404);
    expect((await remove(t.ws, 'nope', t.owner.cookie)).status).toBe(422);
    expect((await patchRole(t.ws, 'nope', 'admin', t.owner.cookie)).status).toBe(422);
    expect((await transfer(t.ws, 'nope', t.owner.cookie)).status).toBe(422);
  });

  it('answers the same 404 to outsiders on every member route', async () => {
    const t = await team();
    const outsider = await h.createUser();
    const unknown = await h.request(`/api/workspaces/${crypto.randomUUID()}/members`, {
      cookie: outsider.cookie,
    });
    expect(unknown.status).toBe(404);
    const body = await unknown.json();
    for (const res of [
      await h.request(`/api/workspaces/${t.ws}/members`, { cookie: outsider.cookie }),
      await patchRole(t.ws, t.member.id, 'admin', outsider.cookie),
      await remove(t.ws, t.member.id, outsider.cookie),
      await transfer(t.ws, outsider.id, outsider.cookie),
      await h.request(`/api/workspaces/${t.ws}/audit`, { cookie: outsider.cookie }),
    ]) {
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual(body);
    }
    expect(await roleOf(t.ws, t.member.id, t.owner.cookie)).toBe('member');
  });

  it('applies the removal matrix and lets members leave', async () => {
    const t = await team();
    expect((await remove(t.ws, t.admin.id, t.member.cookie)).status).toBe(403);
    expect((await remove(t.ws, t.owner.id, t.admin.cookie)).status).toBe(403);
    expect((await remove(t.ws, t.member.id, t.admin.cookie)).status).toBe(204);
    expect((await remove(t.ws, t.admin.id, t.admin.cookie)).status).toBe(204);
    const soleOwnerLeave = await remove(t.ws, t.owner.id, t.owner.cookie);
    expect(soleOwnerLeave.status).toBe(409);
    expect(await soleOwnerLeave.json()).toMatchObject({ detail: 'last_owner' });
    expect((await h.request(`/api/workspaces/${t.ws}`, { cookie: t.member.cookie })).status).toBe(
      404,
    );
    expect(await listAuditActions(h.deps.db, t.ws)).toContain('member.removed');
  });

  it('lets an owner leave when another owner remains', async () => {
    const t = await team();
    await patchRole(t.ws, t.admin.id, 'owner', t.owner.cookie);
    expect((await remove(t.ws, t.owner.id, t.owner.cookie)).status).toBe(204);
  });

  it('transfers ownership and steps the previous owner down to admin', async () => {
    const t = await team();
    const res = await transfer(t.ws, t.member.id, t.owner.cookie);
    expect(res.status).toBe(204);
    const items = await members(t.ws, t.owner.cookie);
    expect(items.find((m) => m.userId === t.member.id)?.role).toBe('owner');
    expect(items.find((m) => m.userId === t.owner.id)?.role).toBe('admin');
    const page = await audit(t.ws, '?action=workspace.ownership_transferred', t.owner.cookie);
    expect(page.items).toEqual([
      expect.objectContaining({
        targetType: 'workspace',
        targetId: t.ws,
        actor: { type: 'user', id: t.owner.id, name: t.owner.name },
        data: { from: t.owner.id, to: t.member.id },
      }),
    ]);
  });

  it('refuses transfers by non-owners, to self, to outsiders and in personal workspaces', async () => {
    const t = await team();
    const outsider = await h.createUser();
    expect((await transfer(t.ws, t.member.id, t.admin.cookie)).status).toBe(403);
    expect((await transfer(t.ws, t.member.id, t.member.cookie)).status).toBe(403);
    const self = await transfer(t.ws, t.owner.id, t.owner.cookie);
    expect(self.status).toBe(422);
    expect(await self.json()).toMatchObject({
      code: 'validation_failed',
      detail: 'target_is_self',
    });
    expect((await transfer(t.ws, outsider.id, t.owner.cookie)).status).toBe(404);
    const personalId = t.owner.personalWorkspaceId ?? '';
    await seedMembership(h.deps.db, personalId, t.member.id, 'member');
    const personal = await transfer(personalId, t.member.id, t.owner.cookie);
    expect(personal.status).toBe(409);
    expect(await personal.json()).toMatchObject({ detail: 'personal_workspace' });
    expect(await listAuditActions(h.deps.db, t.ws)).not.toContain(
      'workspace.ownership_transferred',
    );
    expect(await listAuditActions(h.deps.db, personalId)).not.toContain(
      'workspace.ownership_transferred',
    );
  });

  it('never leaves a workspace without an owner under concurrent demotions', async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const ws = await seedCommunityWorkspace(h.deps.db, a.id);
    await seedMembership(h.deps.db, ws, b.id, 'owner');
    const [r1, r2] = await Promise.all([
      patchRole(ws, b.id, 'admin', a.cookie),
      patchRole(ws, a.id, 'admin', b.cookie),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses[0]).toBe(200);
    expect([403, 409]).toContain(statuses[1]);
    const items = await members(ws, a.cookie);
    expect(items.filter((m) => m.role === 'owner')).toHaveLength(1);
  });

  describe('role checks decide on the state at write time', () => {
    it('refuses a role change by an admin demoted while the request waited', async () => {
      const t = await team();
      const res = await underWorkspaceLock(t.ws, setRole(t.ws, t.admin.id, 'member'), () =>
        patchRole(t.ws, t.member.id, 'admin', t.admin.cookie),
      );
      expect(res.status).toBe(403);
      expect(await roleOf(t.ws, t.member.id, t.owner.cookie)).toBe('member');
    });

    it('answers 404 to an actor removed while the request waited', async () => {
      const t = await team();
      const res = await underWorkspaceLock(t.ws, dropMember(t.ws, t.admin.id), () =>
        remove(t.ws, t.member.id, t.admin.cookie),
      );
      expect(res.status).toBe(404);
      expect(await roleOf(t.ws, t.member.id, t.owner.cookie)).toBe('member');
    });

    it('refuses a transfer by an owner demoted while the request waited', async () => {
      const t = await team();
      await seedMembership(h.deps.db, t.ws, (await h.createUser()).id, 'owner');
      const res = await underWorkspaceLock(t.ws, setRole(t.ws, t.owner.id, 'admin'), () =>
        transfer(t.ws, t.member.id, t.owner.cookie),
      );
      expect(res.status).toBe(403);
      expect(await roleOf(t.ws, t.member.id, t.admin.cookie)).toBe('member');
    });

    it('refuses a rename by an admin demoted while the request waited', async () => {
      const t = await team();
      const res = await underWorkspaceLock(t.ws, setRole(t.ws, t.admin.id, 'member'), () =>
        h.request(`/api/workspaces/${t.ws}`, {
          method: 'PATCH',
          body: { name: 'Renamed' },
          cookie: t.admin.cookie,
        }),
      );
      expect(res.status).toBe(403);
      const ws = (await (
        await h.request(`/api/workspaces/${t.ws}`, { cookie: t.owner.cookie })
      ).json()) as {
        name: string;
      };
      expect(ws.name).not.toBe('Renamed');
    });

    it('refuses a delete by an owner demoted while the request waited', async () => {
      const t = await team();
      await seedMembership(h.deps.db, t.ws, (await h.createUser()).id, 'owner');
      const res = await underWorkspaceLock(t.ws, setRole(t.ws, t.owner.id, 'admin'), () =>
        h.request(`/api/workspaces/${t.ws}`, { method: 'DELETE', cookie: t.owner.cookie }),
      );
      expect(res.status).toBe(403);
      expect((await h.request(`/api/workspaces/${t.ws}`, { cookie: t.owner.cookie })).status).toBe(
        200,
      );
    });
  });

  it('pages the audit log newest first, filters by action and hides it from outsiders', async () => {
    const t = await team();
    await patchRole(t.ws, t.member.id, 'admin', t.owner.cookie);
    await patchRole(t.ws, t.member.id, 'member', t.owner.cookie);
    const first = await audit(t.ws, '?limit=2', t.member.cookie);
    expect(first.items.map((i) => i.action)).toEqual([
      'member.role_changed',
      'member.role_changed',
    ]);
    expect(first.nextCursor).not.toBeNull();
    const rest = await audit(
      t.ws,
      `?limit=100&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      t.member.cookie,
    );
    expect(rest.items.map((i) => i.action)).toEqual(
      expect.arrayContaining(['member.added', 'workspace.created']),
    );
    expect(rest.nextCursor).toBeNull();
    const added = await audit(t.ws, '?action=member.added', t.member.cookie);
    expect(added.items).toHaveLength(3);
    expect(added.items.every((i) => i.action === 'member.added')).toBe(true);
    expect(
      (await h.request(`/api/workspaces/${t.ws}/audit?cursor=garbage`, { cookie: t.member.cookie }))
        .status,
    ).toBe(422);
    expect(
      (
        await h.request(`/api/workspaces/${t.ws}/audit?action=no.such_action`, {
          cookie: t.member.cookie,
        })
      ).status,
    ).toBe(422);
    const outsider = await h.createUser();
    expect(
      (await h.request(`/api/workspaces/${t.ws}/audit`, { cookie: outsider.cookie })).status,
    ).toBe(404);
  });

  it('walks the whole log through the cursor without gaps or repeats', async () => {
    const t = await team();
    for (const role of ['admin', 'member', 'admin', 'member'])
      await patchRole(t.ws, t.member.id, role, t.owner.cookie);
    const all = await audit(t.ws, '?limit=100', t.owner.cookie);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string =
        cursor === null ? '?limit=3' : `?limit=3&cursor=${encodeURIComponent(cursor)}`;
      const page = await audit(t.ws, query, t.owner.cookie);
      expect(page.items.length).toBeLessThanOrEqual(3);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(all.items.map((i) => i.id));
    expect(new Set(seen).size).toBe(seen.length);
    const times = all.items.map((i) => Date.parse(i.createdAt));
    expect(times).toEqual([...times].sort((x, y) => y - x));
  });

  it('describes actors and keeps other workspaces out', async () => {
    const t = await team();
    const other = await team();
    await patchRole(other.ws, other.member.id, 'admin', other.owner.cookie);
    await patchRole(t.ws, t.member.id, 'admin', t.admin.cookie);
    await remove(t.ws, t.admin.id, t.admin.cookie);
    const page = await audit(t.ws, '?limit=100', t.owner.cookie);
    const otherIds = new Set(
      (await audit(other.ws, '?limit=100', other.owner.cookie)).items.map((i) => i.id),
    );
    expect(page.items.some((i) => otherIds.has(i.id))).toBe(false);
    for (const item of page.items) {
      expect(JSON.stringify(item)).not.toContain(other.ws);
      expect(JSON.stringify(item)).not.toContain(other.member.id);
    }
    const created = page.items.find((i) => i.action === 'workspace.created');
    expect(created?.actor).toEqual({ type: 'system', id: null, name: null });
    // the admin left: the id stays, the name is no longer known
    const changed = page.items.find((i) => i.action === 'member.role_changed');
    expect(changed?.actor).toEqual({ type: 'user', id: t.admin.id, name: null });
    expect(changed?.data).toEqual({ from: 'member', to: 'admin' });
    const left = page.items.find((i) => i.action === 'member.removed');
    expect(left).toMatchObject({
      targetType: 'member',
      targetId: t.admin.id,
      data: { role: 'admin', self: true },
    });
  });

  it('validates the audit query', async () => {
    const t = await team();
    for (const query of [
      '?limit=0',
      '?limit=101',
      '?limit=abc',
      '?limit=1.5',
      `?cursor=${'A'.repeat(201)}`,
    ]) {
      const res = await h.request(`/api/workspaces/${t.ws}/audit${query}`, {
        cookie: t.member.cookie,
      });
      expect(res.status, query).toBe(422);
      expect(await res.json()).toMatchObject({ code: 'validation_failed' });
    }
    const forged = Buffer.from(`2026-10-12T09:30:00.123Z|not-a-uuid`).toString('base64url');
    const res = await h.request(`/api/workspaces/${t.ws}/audit?cursor=${forged}`, {
      cookie: t.member.cookie,
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).not.toContain('not-a-uuid');
    expect((await audit(t.ws, '', t.member.cookie)).items.length).toBeGreaterThan(0);
  });
});
