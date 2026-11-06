import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemError } from '../../errors.js';
import { type AppFixture, createAppFixture } from '../../test/app-fixtures.js';
import { problem } from '../problem.js';
import type { AppEnv } from '../types.js';
import { catalogAuth, installationAuth } from './installation-auth.js';
import { requestId } from './request-id.js';

let fx: AppFixture;
let mini: Hono<AppEnv>;
let ws: string;

beforeAll(async () => {
  fx = await createAppFixture();
  ws = await fx.workspace('alpha');
  mini = new Hono<AppEnv>();
  // As in the real app: the request logger is in place before the auth middleware runs.
  mini.use('*', requestId(fx.deps.logger));
  mini.onError((err, c) =>
    err instanceof ProblemError ? problem(c, err) : c.text(String(err), 500),
  );
  mini.use('/inst', installationAuth(fx.deps.db, { allowQueryToken: false }));
  mini.get('/inst', (c) => c.json(c.get('installation')));
  mini.use('/hook', installationAuth(fx.deps.db, { allowQueryToken: true }));
  mini.get('/hook', (c) => c.json(c.get('installation')));
  mini.use('/cat', catalogAuth(fx.deps));
  mini.get('/cat', (c) => c.json(c.get('catalogPrincipal')));
}, 120_000);

afterAll(async () => {
  await fx?.close();
});

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });
const code = async (res: Response) => ((await res.json()) as { code: string }).code;

describe('installationAuth', () => {
  it('accepts a valid installation token', async () => {
    const { token, installationId, appId } = await fx.privateApp(ws, { grantedTypes: ['generic'] });
    const res = await mini.request('/inst', bearer(token));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      installationId,
      workspaceId: ws,
      appId,
      appVisibility: 'private',
      grantedTypes: ['generic'],
    });
  });

  it('accepts ?token= only where allowed', async () => {
    const { token } = await fx.privateApp(ws);
    expect((await mini.request(`/hook?token=${token}`)).status).toBe(200);
    const res = await mini.request(`/inst?token=${token}`);
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthorized');
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects missing, unknown and wrong-kind tokens', async () => {
    const { appKey } = await fx.publicApp(ws);
    expect((await mini.request('/inst')).status).toBe(401);
    expect((await mini.request('/inst', bearer('ow_inst_doesnotexist'))).status).toBe(401);
    expect((await mini.request('/inst', bearer(appKey))).status).toBe(401);
  });

  it('answers unknown, overlong and wrong-kind tokens the same way, without echoing them', async () => {
    const { token } = await fx.privateApp(ws);
    const { appKey } = await fx.publicApp(ws);
    for (const candidate of [`ow_inst_${'x'.repeat(43)}`, `${token}${'y'.repeat(200)}`, appKey]) {
      const res = await mini.request('/inst', bearer(candidate));
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      const text = await res.text();
      expect((JSON.parse(text) as { code: string }).code).toBe('unauthorized');
      expect(text).not.toContain(candidate.slice(-16));
      expect(text).not.toContain(token.slice(-16));
    }
  });

  it('reports revoked installations distinctly', async () => {
    const { token, installationId } = await fx.privateApp(ws);
    await fx.owner.query(
      `update installations set status = 'revoked', revoked_at = now() where id = $1`,
      [installationId],
    );
    const res = await mini.request('/inst', bearer(token));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('installation_revoked');
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it.each(['rejected', 'pending'] as const)(
    'answers app_not_approved for installations of %s apps',
    async (status) => {
      const other = await fx.workspace(`beta-${status}`);
      const { appId } = await fx.publicApp(ws);
      const { token } = await fx.install(other, appId);
      await fx.owner.query(`update apps set approval_status = $2 where id = $1`, [appId, status]);
      const res = await mini.request('/inst', bearer(token));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('app_not_approved');
    },
  );

  it('applies a re-approval to the next request (no cache)', async () => {
    const other = await fx.workspace('beta-reapproved');
    const { appId } = await fx.publicApp(ws);
    const { token } = await fx.install(other, appId);
    await fx.owner.query(`update apps set approval_status = 'rejected' where id = $1`, [appId]);
    expect((await mini.request('/inst', bearer(token))).status).toBe(403);
    await fx.owner.query(`update apps set approval_status = 'approved' where id = $1`, [appId]);
    expect((await mini.request('/inst', bearer(token))).status).toBe(200);
  });

  it('refuses the token of an installation created while the approval was being withdrawn', async () => {
    // createInstallation reads the app without a lock; the token check is the guard (documented in the repository).
    // In practice the withdrawal nearly always wins this free race; the forced-order test below covers the other
    // order. A few runs still guard against either outcome letting a token through.
    for (let i = 0; i < 8; i++) {
      const other = await fx.workspace(`delta-race-${i}`);
      const { appId } = await fx.publicApp(ws);
      const [installed] = await Promise.allSettled([
        fx.install(other, appId),
        fx.owner.query(`update apps set approval_status = 'rejected' where id = $1`, [appId]),
      ]);
      // Either the withdrawal won (the app is no longer visible: the install fails as not found), or the install
      // won and its token is refused from the first request on. No order lets a token through.
      if (installed.status === 'rejected') {
        expect(installed.reason).toMatchObject({ name: 'RepoNotFoundError' });
        continue;
      }
      const res = await mini.request('/inst', bearer(installed.value.token));
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('app_not_approved');
    }
  });

  it('refuses the token of an installation that read the app before its approval was withdrawn', async () => {
    // Forces the order the free race above rarely produces: the install has read the app as approved and waits to
    // insert while the withdrawal commits. A SHARE lock on installations holds the insert (plain reads pass).
    const other = await fx.workspace('delta-interleaved');
    const { appId } = await fx.publicApp(ws);
    const blocker = await fx.owner.connect();
    let installing: ReturnType<AppFixture['install']> | undefined;
    try {
      await blocker.query('begin');
      await blocker.query('lock table installations in share mode');
      installing = fx.install(other, appId);
      const waiting = async () => {
        const { rows } = await fx.owner.query<{ n: number }>(
          `select count(*)::int as n from pg_locks
           where relation = 'installations'::regclass and not granted`,
        );
        return (rows[0]?.n ?? 0) > 0;
      };
      for (let i = 0; i < 200 && !(await waiting()); i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(await waiting()).toBe(true);
      await fx.owner.query(`update apps set approval_status = 'rejected' where id = $1`, [appId]);
    } finally {
      await blocker.query('commit');
      blocker.release();
    }
    if (!installing) throw new Error('the install did not start');
    const { token } = await installing;
    const res = await mini.request('/inst', bearer(token));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('app_not_approved');
  });

  it('rejects tokens of deleted workspaces', async () => {
    const gone = await fx.workspace('gone');
    const { token } = await fx.privateApp(gone);
    await fx.owner.query(`update workspaces set deleted_at = now() where id = $1`, [gone]);
    expect((await mini.request('/inst', bearer(token))).status).toBe(401);
  });

  it('rejects installation tokens of public apps whose owner workspace is deleted', async () => {
    const owner = await fx.workspace('owner-gone');
    const other = await fx.workspace('installer');
    const { appId } = await fx.publicApp(owner);
    const { token } = await fx.install(other, appId);
    expect((await mini.request('/inst', bearer(token))).status).toBe(200);
    await fx.owner.query(`update workspaces set deleted_at = now() where id = $1`, [owner]);
    const res = await mini.request('/inst', bearer(token));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthorized');
  });
});

describe('catalogAuth', () => {
  it('accepts app keys', async () => {
    const { appId, appKey } = await fx.publicApp(ws);
    const res = await mini.request('/cat', bearer(appKey));
    expect(await res.json()).toEqual({
      appId,
      ownerWorkspaceId: ws,
      via: 'app_key',
      installationId: null,
    });
  });

  it('accepts installation tokens of private apps in their own workspace', async () => {
    const { appId, token, installationId } = await fx.privateApp(ws);
    const res = await mini.request('/cat', bearer(token));
    expect(await res.json()).toEqual({
      appId,
      ownerWorkspaceId: ws,
      via: 'installation',
      installationId,
    });
  });

  it('forbids installation tokens of public apps', async () => {
    const other = await fx.workspace('gamma');
    const { appId } = await fx.publicApp(ws);
    const { token } = await fx.install(other, appId);
    const res = await mini.request('/cat', bearer(token));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('forbidden');
  });

  it('rejects missing, unknown and malformed credentials with a bearer challenge', async () => {
    for (const init of [
      undefined,
      bearer('nope'),
      bearer(`ow_app_${'x'.repeat(43)}`),
      bearer(`ow_inst_${'x'.repeat(43)}`),
    ]) {
      const res = await mini.request('/cat', init);
      expect(res.status).toBe(401);
      expect(await code(res)).toBe('unauthorized');
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
    }
  });

  it('accepts app keys of pending apps so the catalog can be prepared before approval', async () => {
    const { appId, appKey } = await fx.publicApp(ws, { approval: 'pending' });
    const res = await mini.request('/cat', bearer(appKey));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      appId,
      ownerWorkspaceId: ws,
      via: 'app_key',
      installationId: null,
    });
  });

  it('answers app_not_approved for app keys of rejected apps', async () => {
    const { appId, appKey } = await fx.publicApp(ws);
    await fx.owner.query(`update apps set approval_status = 'rejected' where id = $1`, [appId]);
    const res = await mini.request('/cat', bearer(appKey));
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('app_not_approved');
  });

  it('rejects app keys of apps whose owner workspace is deleted', async () => {
    const owner = await fx.workspace('key-owner-gone');
    const { appKey } = await fx.publicApp(owner);
    expect((await mini.request('/cat', bearer(appKey))).status).toBe(200);
    await fx.owner.query(`update workspaces set deleted_at = now() where id = $1`, [owner]);
    const res = await mini.request('/cat', bearer(appKey));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthorized');
  });

  it('accepts the previous app key until its grace period ends', async () => {
    const { appId, appKey } = await fx.publicApp(ws);
    const graceEnd = new Date(fx.clock.now().getTime() + 60_000);
    await fx.owner.query(
      `update apps set app_key_prev_hash = app_key_hash, app_key_prev_expires_at = $2,
         app_key_hash = 'rotated-' || id::text where id = $1`,
      [appId, graceEnd],
    );
    expect((await mini.request('/cat', bearer(appKey))).status).toBe(200);
    fx.clock.set(new Date(graceEnd.getTime() + 1));
    const res = await mini.request('/cat', bearer(appKey));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('unauthorized');
  });

  it('reports revoked private installations distinctly', async () => {
    const { token, installationId } = await fx.privateApp(ws);
    await fx.owner.query(
      `update installations set status = 'revoked', revoked_at = now() where id = $1`,
      [installationId],
    );
    const res = await mini.request('/cat', bearer(token));
    expect(res.status).toBe(401);
    expect(await code(res)).toBe('installation_revoked');
  });
});
