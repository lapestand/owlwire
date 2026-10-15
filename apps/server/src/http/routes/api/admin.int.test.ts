import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrapInstanceAdmin } from '../../../system/instance-admin.js';
import { findUserByEmail } from '../../../system/users.js';
import {
  type AuthHarness,
  createAuthHarness,
  TEST_PASSWORD,
  uniqueEmail,
} from '../../../test/auth-harness.js';

const PATH = '/api/admin/settings/registration';

describe('management api: admin settings', () => {
  let h: AuthHarness;
  let adminCookie: string;
  let adminId: string;
  beforeAll(async () => {
    h = await createAuthHarness({ registration: 'open' });
    const email = uniqueEmail('admin');
    ({ userId: adminId } = await bootstrapInstanceAdmin(h.deps, {
      email,
      name: 'Admin',
      password: TEST_PASSWORD,
    }));
    adminCookie = await h.signIn(email);
  });
  afterAll(async () => {
    await h.close();
  });

  it('forbids non-admins', async () => {
    const u = await h.createUser();
    expect((await h.request(PATH, { cookie: u.cookie })).status).toBe(403);
    const put = await h.request(PATH, { method: 'PUT', body: { mode: 'open' }, cookie: u.cookie });
    expect(put.status).toBe(403);
    expect(await put.json()).toMatchObject({ code: 'forbidden' });
    expect((await h.request(PATH)).status).toBe(401);
  });

  it('reads and changes the registration mode, which then gates sign-up', async () => {
    const read = await h.request(PATH, { cookie: adminCookie });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ mode: 'open', source: 'settings' });
    const put = await h.request(PATH, {
      method: 'PUT',
      body: { mode: 'closed' },
      cookie: adminCookie,
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ mode: 'closed', source: 'settings' });
    // The change is on the instance audit trail, with the admin as actor and the key but not the value.
    const audit = await h.harness.ownerPool.query<{
      actor_user_id: string | null;
      target_id: string;
      data: unknown;
    }>(
      `select actor_user_id, target_id, data from audit_log
       where workspace_id is null and action = 'settings.updated' and actor_user_id = $1`,
      [adminId],
    );
    expect(audit.rows).toContainEqual({
      actor_user_id: adminId,
      target_id: 'registration',
      data: { keys: ['registration'] },
    });
    // Sign-up answers a refusal with the generic 200 and creates no user.
    const late = uniqueEmail('late');
    expect((await h.signUp(late)).status).toBe(200);
    expect(await findUserByEmail(h.deps, late)).toBeNull();
    expect(await (await h.request('/api/auth-config')).json()).toMatchObject({
      registration: 'closed',
    });
    const reopened = await h.request(PATH, {
      method: 'PUT',
      body: { mode: 'open' },
      cookie: adminCookie,
    });
    expect(reopened.status).toBe(200);
  });

  it('does not let a user make themselves an instance admin through update-user', async () => {
    const u = await h.createUser();
    const res = await h.request('/api/auth/update-user', {
      method: 'POST',
      body: { isInstanceAdmin: true },
      cookie: u.cookie,
    });
    expect(res.status).toBe(400);
    expect((await findUserByEmail(h.deps, u.email))?.isInstanceAdmin).toBe(false);
    expect((await h.request(PATH, { cookie: u.cookie })).status).toBe(403);
  });

  it('validates the mode', async () => {
    const res = await h.request(PATH, {
      method: 'PUT',
      body: { mode: 'everyone' },
      cookie: adminCookie,
    });
    expect(res.status).toBe(422);
  });

  it('refuses a cross-site change', async () => {
    const res = await h.request(PATH, {
      method: 'PUT',
      body: { mode: 'closed' },
      cookie: adminCookie,
      headers: { origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
  });
});
