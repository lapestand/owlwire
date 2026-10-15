import { listAuditActions, seedMembership } from '@owlwire/db/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SESSION_EXPIRES_IN_SECONDS } from '../../../auth/auth.js';
import { createAuthHooks } from '../../../auth/hooks.js';
import { type AuthHarness, createAuthHarness, uniqueEmail } from '../../../test/auth-harness.js';
import { resolveWorkspaceContext } from '../../middleware/workspace-access.js';
import { createApiRouter } from './index.js';

interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  kind: 'personal' | 'community';
  role: 'owner' | 'admin' | 'member';
  createdAt: string;
}
interface MeDto {
  user: {
    id: string;
    name: string;
    email: string;
    emailVerified: boolean;
    image: string | null;
    twoFactorEnabled: boolean;
  };
  isInstanceAdmin: boolean;
  personalWorkspaceId: string;
}

const sessionToken = (cookie: string) =>
  decodeURIComponent(/owlwire\.session_token=([^;]+)/.exec(cookie)?.[1] ?? '').split('.')[0] ?? '';

describe('management api: workspaces', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  async function createWorkspace(cookie: string, body: Record<string, unknown>): Promise<Response> {
    return h.request('/api/workspaces', { body, cookie });
  }
  async function listIds(cookie: string): Promise<string[]> {
    const res = await h.request('/api/workspaces', { cookie });
    return ((await res.json()) as { items: WorkspaceDto[] }).items.map((w) => w.id);
  }

  it('rejects requests without a session', async () => {
    for (const path of ['/api/workspaces', '/api/me', '/api/workspaces/not-a-uuid']) {
      const res = await h.request(path);
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'unauthorized' });
    }
    const post = await h.request('/api/workspaces', { body: { name: 'X' } });
    expect(post.status).toBe(401);
  });

  it('returns the current user with the personal workspace', async () => {
    const u = await h.createUser(undefined, { name: 'Ayşe' });
    const res = await h.request('/api/me', { cookie: u.cookie });
    expect(res.status).toBe(200);
    const me = (await res.json()) as MeDto;
    expect(me).toEqual({
      user: {
        id: u.id,
        name: 'Ayşe',
        email: u.email,
        emailVerified: true,
        image: null,
        twoFactorEnabled: false,
      },
      isInstanceAdmin: false,
      personalWorkspaceId: u.personalWorkspaceId,
    });
    const list = (await (await h.request('/api/workspaces', { cookie: u.cookie })).json()) as {
      items: WorkspaceDto[];
    };
    expect(list.items).toEqual([
      expect.objectContaining({ id: me.personalWorkspaceId, kind: 'personal', role: 'owner' }),
    ]);
  });

  it('forwards the re-issued session cookie when the session is extended', async () => {
    const u = await h.createUser();
    // Two days into a 30-day session: due for its daily extension.
    const { rowCount } = await h.harness.ownerPool.query(
      "update auth_session set expires_at = now() + interval '28 days' where token = $1",
      [sessionToken(u.cookie)],
    );
    expect(rowCount).toBe(1);
    const res = await h.request('/api/workspaces', { cookie: u.cookie });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith('owlwire.session_token='));
    expect(cookie).toMatch(new RegExp(`Max-Age=${SESSION_EXPIRES_IN_SECONDS}`));
    // A fresh session is not extended, so nothing is re-issued.
    const fresh = await h.request('/api/me', { cookie: (await h.createUser()).cookie });
    expect(fresh.headers.getSetCookie()).toEqual([]);
  });

  it('exposes public auth configuration without a session', async () => {
    const res = await h.request('/api/auth-config');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      registration: 'open',
      socialProviders: [],
      emailEnabled: true,
      passkeys: true,
    });
  });

  it('creates a community workspace with a generated slug and makes the creator owner', async () => {
    const u = await h.createUser();
    const res = await createWorkspace(u.cookie, { name: 'Kurt Sürüsü' });
    expect(res.status).toBe(201);
    const ws = (await res.json()) as WorkspaceDto;
    expect(ws).toMatchObject({ name: 'Kurt Sürüsü', kind: 'community', role: 'owner' });
    expect(ws.slug).toMatch(/^kurt-surusu-[0-9a-f]{6}$/);
    const got = await h.request(`/api/workspaces/${ws.id}`, { cookie: u.cookie });
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual(ws);
    expect(await listIds(u.cookie)).toEqual([u.personalWorkspaceId, ws.id]);
    expect(await listAuditActions(h.deps.db, ws.id)).toEqual(
      expect.arrayContaining(['workspace.created', 'member.added']),
    );
  });

  it('refuses a taken slug with 409 and a reserved or personal slug with 422', async () => {
    const u = await h.createUser();
    const slug = `ally-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    expect((await createWorkspace(u.cookie, { name: 'A', slug })).status).toBe(201);
    const dup = await createWorkspace(u.cookie, { name: 'B', slug });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ code: 'conflict', detail: 'slug_taken' });
    for (const reservedSlug of [`p-${'a'.repeat(32)}`, 'admin', 'api']) {
      const reserved = await createWorkspace(u.cookie, { name: 'C', slug: reservedSlug });
      expect(reserved.status).toBe(422);
      const body = (await reserved.json()) as { code: string; detail: string };
      expect(body.code).toBe('validation_failed');
      expect(body.detail).not.toContain(reservedSlug);
    }
  });

  it('renames the slug, refuses a taken or reserved one and keeps the old on failure', async () => {
    const u = await h.createUser();
    const a = (await (await createWorkspace(u.cookie, { name: 'A' })).json()) as WorkspaceDto;
    const b = (await (await createWorkspace(u.cookie, { name: 'B' })).json()) as WorkspaceDto;
    const next = `renamed-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const ok = await h.request(`/api/workspaces/${a.id}`, {
      method: 'PATCH',
      body: { slug: next },
      cookie: u.cookie,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ id: a.id, slug: next, name: 'A' });
    const taken = await h.request(`/api/workspaces/${b.id}`, {
      method: 'PATCH',
      body: { slug: next },
      cookie: u.cookie,
    });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toMatchObject({ code: 'conflict', detail: 'slug_taken' });
    const reserved = await h.request(`/api/workspaces/${b.id}`, {
      method: 'PATCH',
      body: { slug: 'settings' },
      cookie: u.cookie,
    });
    expect(reserved.status).toBe(422);
    const after = (await (
      await h.request(`/api/workspaces/${b.id}`, { cookie: u.cookie })
    ).json()) as WorkspaceDto;
    expect(after.slug).toBe(b.slug);
  });

  it('answers 404 for malformed, unknown, foreign and deleted workspaces', async () => {
    const a = await h.createUser();
    const b = await h.createUser();
    const foreign = (await (
      await createWorkspace(b.cookie, { name: 'Foreign' })
    ).json()) as WorkspaceDto;
    const notFoundBodies: unknown[] = [];
    for (const id of ['not-a-uuid', '00000000-0000-7000-8000-000000000000', foreign.id]) {
      const res = await h.request(`/api/workspaces/${id}`, { cookie: a.cookie });
      expect(res.status).toBe(404);
      notFoundBodies.push(await res.json());
    }
    expect(notFoundBodies[0]).toMatchObject({ code: 'not_found' });
    // The same body for every case, so existence is not revealed.
    expect(new Set(notFoundBodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await resolveWorkspaceContext(h.deps.db, a.id, 'not-a-uuid')).toBeNull();
    expect(await resolveWorkspaceContext(h.deps.db, a.id, foreign.id)).toBeNull();
    const mine = (await (await createWorkspace(a.cookie, { name: 'Temp' })).json()) as WorkspaceDto;
    expect((await resolveWorkspaceContext(h.deps.db, a.id, mine.id))?.role).toBe('owner');
    expect(
      (await h.request(`/api/workspaces/${mine.id}`, { method: 'DELETE', cookie: a.cookie }))
        .status,
    ).toBe(204);
    const deleted = await h.request(`/api/workspaces/${mine.id}`, { cookie: a.cookie });
    expect(deleted.status).toBe(404);
    expect(await deleted.json()).toEqual(notFoundBodies[0]);
    expect(await listAuditActions(h.deps.db, mine.id)).toContain('workspace.deleted');
  });

  it('hides a deleted workspace from every management endpoint and the list', async () => {
    const owner = await h.createUser();
    const member = await h.createUser();
    const ws = (await (
      await createWorkspace(owner.cookie, { name: 'Gone' })
    ).json()) as WorkspaceDto;
    await seedMembership(h.deps.db, ws.id, member.id, 'member');
    expect(await listIds(member.cookie)).toContain(ws.id);
    expect(
      (await h.request(`/api/workspaces/${ws.id}`, { method: 'DELETE', cookie: owner.cookie }))
        .status,
    ).toBe(204);
    for (const u of [owner, member]) {
      expect(await listIds(u.cookie)).not.toContain(ws.id);
      expect(await resolveWorkspaceContext(h.deps.db, u.id, ws.id)).toBeNull();
      for (const init of [
        { method: 'GET' },
        { method: 'PATCH', body: { name: 'Back' } },
        { method: 'DELETE' },
      ]) {
        const res = await h.request(`/api/workspaces/${ws.id}`, { ...init, cookie: u.cookie });
        expect(res.status, `${init.method}`).toBe(404);
        expect(await res.json()).toMatchObject({ code: 'not_found' });
      }
    }
    expect(
      (await listAuditActions(h.deps.db, ws.id)).filter((a) => a === 'workspace.deleted'),
    ).toHaveLength(1);
  });

  it('lets admins rename, forbids members, and protects the personal workspace', async () => {
    const owner = await h.createUser();
    const member = await h.createUser();
    const admin = await h.createUser();
    const ws = (await (
      await createWorkspace(owner.cookie, { name: 'Old' })
    ).json()) as WorkspaceDto;
    await seedMembership(h.deps.db, ws.id, member.id, 'member');
    await seedMembership(h.deps.db, ws.id, admin.id, 'admin');
    const memberView = await h.request(`/api/workspaces/${ws.id}`, { cookie: member.cookie });
    expect(await memberView.json()).toMatchObject({ id: ws.id, role: 'member' });
    const denied = await h.request(`/api/workspaces/${ws.id}`, {
      method: 'PATCH',
      body: { name: 'X' },
      cookie: member.cookie,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'forbidden' });
    const renamed = await h.request(`/api/workspaces/${ws.id}`, {
      method: 'PATCH',
      body: { name: 'New' },
      cookie: admin.cookie,
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ name: 'New', role: 'admin' });
    expect(await listAuditActions(h.deps.db, ws.id)).toContain('workspace.updated');
    for (const u of [member, admin]) {
      const res = await h.request(`/api/workspaces/${ws.id}`, {
        method: 'DELETE',
        cookie: u.cookie,
      });
      expect(res.status).toBe(403);
    }
    const personalDelete = await h.request(`/api/workspaces/${owner.personalWorkspaceId}`, {
      method: 'DELETE',
      cookie: owner.cookie,
    });
    expect(personalDelete.status).toBe(409);
    expect(await personalDelete.json()).toMatchObject({ detail: 'personal_workspace' });
    const personalSlug = await h.request(`/api/workspaces/${owner.personalWorkspaceId}`, {
      method: 'PATCH',
      body: { slug: 'my-new-slug' },
      cookie: owner.cookie,
    });
    expect(personalSlug.status).toBe(409);
    expect(await personalSlug.json()).toMatchObject({ detail: 'personal_workspace' });
    const personalName = await h.request(`/api/workspaces/${owner.personalWorkspaceId}`, {
      method: 'PATCH',
      body: { name: 'Mine' },
      cookie: owner.cookie,
    });
    expect(personalName.status).toBe(200);
    expect(await personalName.json()).toMatchObject({ name: 'Mine', kind: 'personal' });
  });

  it('validates the request body with 422 and malformed JSON with 400', async () => {
    const u = await h.createUser();
    const res = await createWorkspace(u.cookie, { name: '' });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'validation_failed' });
    const tooLong = await createWorkspace(u.cookie, { name: '🦉'.repeat(81) });
    expect(tooLong.status).toBe(422);
    const emptyPatch = await h.request(`/api/workspaces/${u.personalWorkspaceId}`, {
      method: 'PATCH',
      body: {},
      cookie: u.cookie,
    });
    expect(emptyPatch.status).toBe(422);
    const malformed = await h.request('/api/workspaces', { rawBody: '{"name":', cookie: u.cookie });
    expect(malformed.status).toBe(400);
    const body = (await malformed.json()) as { code: string; detail?: string };
    expect(body.code).toBe('validation_failed');
    expect(body.detail ?? '').not.toContain('{"name":');
  });

  it('tags every management route as internal in OpenAPI and names the AuthConfig component', () => {
    const doc = createApiRouter(h.deps).getOpenAPI31Document({
      openapi: '3.1.0',
      info: { title: 'test', version: '0' },
    });
    const operations = Object.values(doc.paths ?? {}).flatMap((item) =>
      Object.values(item as Record<string, { tags?: string[] }>),
    );
    expect(operations.length).toBeGreaterThan(0);
    for (const op of operations) expect(op.tags).toContain('internal');
    expect(Object.keys(doc.components?.schemas ?? {})).toContain('AuthConfig');
    expect(Object.keys(doc.components?.securitySchemes ?? {})).toContain('cookieAuth');
  });
});

describe('management api: personal workspace repair', () => {
  let h: AuthHarness;
  beforeAll(async () => {
    h = await createAuthHarness({
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

  it('creates the missing personal workspace on GET /api/me', async () => {
    const u = await h.createUser(uniqueEmail('repair'));
    expect(u.personalWorkspaceId).toBeNull();
    const before = (await (await h.request('/api/workspaces', { cookie: u.cookie })).json()) as {
      items: unknown[];
    };
    expect(before.items).toHaveLength(0);
    const meRes = await h.request('/api/me', { cookie: u.cookie });
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as MeDto;
    const after = (await (await h.request('/api/workspaces', { cookie: u.cookie })).json()) as {
      items: WorkspaceDto[];
    };
    expect(after.items.map((w) => w.id)).toEqual([me.personalWorkspaceId]);
    expect(after.items[0]).toMatchObject({ kind: 'personal', role: 'owner' });
    // Repeated calls find the same workspace by its owner.
    const again = (await (await h.request('/api/me', { cookie: u.cookie })).json()) as MeDto;
    expect(again.personalWorkspaceId).toBe(me.personalWorkspaceId);
  });
});
