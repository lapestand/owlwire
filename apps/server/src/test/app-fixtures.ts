import { FakeClock, newId } from '@owlwire/core';
import { issueToken } from '@owlwire/crypto';
import {
  type CatalogTypeUpsert,
  createApp,
  createInstallation,
  createWorkspace,
  SYSTEM_ACTOR,
  type TenantTx,
  tenantScope,
  upsertCatalogTypes,
  withTenant,
} from '@owlwire/db';
import type pg from 'pg';
import { type AuthHarness, createAuthHarness, TEST_BASE_URL } from './auth-harness.js';

/** @public Fixture for app, catalog and installation tests. */
export interface AppFixture {
  h: AuthHarness;
  deps: AuthHarness['deps'];
  clock: FakeClock;
  /** Owner-role pool for raw seeding and assertions only; production code never uses it. */
  owner: pg.Pool;
  request(path: string, init?: RequestInit): Promise<Response>;
  api(cookie: string, path: string, method?: string, body?: unknown): Promise<Response>;
  workspace(name?: string): Promise<string>;
  user(opts?: { instanceAdmin?: boolean }): Promise<{ userId: string; cookie: string }>;
  member(workspaceId: string, userId: string, role: 'owner' | 'admin' | 'member'): Promise<void>;
  privateApp(
    workspaceId: string,
    opts?: { catalog?: CatalogTypeUpsert[]; grantedTypes?: string[] | null },
  ): Promise<{ appId: string; installationId: string; token: string }>;
  publicApp(
    ownerWorkspaceId: string,
    opts?: { approval?: 'approved' | 'pending'; catalog?: CatalogTypeUpsert[] },
  ): Promise<{ appId: string; appKey: string }>;
  install(
    workspaceId: string,
    appId: string,
    grantedTypes?: string[] | null,
  ): Promise<{ installationId: string; token: string }>;
  close(): Promise<void>;
}

/**
 * Thin wrapper over createAuthHarness: seeding goes through the repositories, raw SQL only through the owner pool.
 */
export async function createAppFixture(): Promise<AppFixture> {
  const clock = new FakeClock(new Date('2026-10-12T09:00:00Z'));
  const h = await createAuthHarness({ clock });
  // The harness owns this pool and ends it in h.close().
  const owner = h.harness.ownerPool;
  const inWs = <T>(workspaceId: string, fn: (t: TenantTx) => Promise<T>) =>
    withTenant(h.deps.db, tenantScope(workspaceId), fn);

  const request = async (path: string, init?: RequestInit) =>
    h.app.request(new URL(path, TEST_BASE_URL).toString(), init);

  async function install(workspaceId: string, appId: string, grantedTypes: string[] | null = null) {
    const issued = issueToken('inst');
    const inst = await inWs(workspaceId, (t) =>
      createInstallation(
        t,
        { appId, tokenHash: issued.hash, tokenPrefix: issued.prefix, grantedTypes },
        SYSTEM_ACTOR,
      ),
    );
    return { installationId: inst.id, token: issued.token };
  }

  return {
    h,
    deps: h.deps,
    clock,
    owner,
    request,

    api: (cookie, path, method = 'GET', body) =>
      request(path, {
        method,
        headers: {
          cookie,
          origin: TEST_BASE_URL,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),

    async workspace(name = 'ws') {
      const id = newId();
      await inWs(id, (t) =>
        createWorkspace(
          t,
          { name, slug: `${name}-${id.slice(-12)}`, kind: 'community' },
          SYSTEM_ACTOR,
        ),
      );
      return id;
    },

    async user(opts = {}) {
      const u = await h.createUser();
      if (!opts.instanceAdmin) return { userId: u.id, cookie: u.cookie };
      await owner.query(`update auth_user set is_instance_admin = true where id = $1`, [u.id]);
      return { userId: u.id, cookie: await h.signIn(u.email) };
    },

    async member(workspaceId, userId, role) {
      await owner.query(
        `insert into memberships (workspace_id, user_id, role, created_at) values ($1, $2, $3, now())
         on conflict (workspace_id, user_id) do update set role = excluded.role`,
        [workspaceId, userId, role],
      );
    },

    async privateApp(workspaceId, opts = {}) {
      const app = await inWs(workspaceId, async (t) => {
        const row = await createApp(
          t,
          { name: 'Test App', slug: `test-${newId().slice(-12)}`, visibility: 'private' },
          SYSTEM_ACTOR,
        );
        if (opts.catalog?.length) await upsertCatalogTypes(t, row.id, opts.catalog, SYSTEM_ACTOR);
        return row;
      });
      return { appId: app.id, ...(await install(workspaceId, app.id, opts.grantedTypes ?? null)) };
    },

    async publicApp(ownerWorkspaceId, opts = {}) {
      const key = issueToken('app');
      const app = await inWs(ownerWorkspaceId, async (t) => {
        const row = await createApp(
          t,
          {
            name: 'Public App',
            slug: `public-${newId().slice(-12)}`,
            visibility: 'public',
            appKey: { hash: key.hash, prefix: key.prefix },
          },
          SYSTEM_ACTOR,
        );
        if (opts.catalog?.length) await upsertCatalogTypes(t, row.id, opts.catalog, SYSTEM_ACTOR);
        return row;
      });
      // Public apps start pending. Test code may not open system scopes, so the seed approves through the owner
      // pool, which the approval trigger lets through.
      if ((opts.approval ?? 'approved') === 'approved') {
        await owner.query(`update apps set approval_status = 'approved' where id = $1`, [app.id]);
      }
      return { appId: app.id, appKey: key.token };
    },

    install,

    close: () => h.close(),
  };
}
