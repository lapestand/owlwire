import { randomUUID } from 'node:crypto';
import { generateToken, hashToken, tokenPrefix } from '@owlwire/crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { pgErrorCode, RepoConflictError, RepoNotFoundError } from '../errors.js';
import { apps, instanceSettings } from '../schema/index.js';
import {
  SYSTEM,
  type SystemTx,
  type TenantTx,
  tenantScope,
  withSystem,
  withTenant,
} from '../scope.js';
import {
  findInstallationByTokenHash,
  type InstallationAuthRecord,
  listWorkspaces,
  resolveWorkspaceOf,
  type TenantEntityKind,
} from '../system/lookups.js';
import {
  getInstanceSetting,
  InvalidSettingValueError,
  setInstanceSetting,
} from '../system/settings.js';
import { type AppRow, type CreateAppInput, createApp, getApp, listOwnApps } from './apps.js';
import { listAuditLog, listSystemAuditLog, SYSTEM_ACTOR } from './audit.js';
import { createConnection } from './connections.js';
import { q } from './context.js';
import { createDestination } from './destinations.js';
import {
  createInstallation,
  getInstallation,
  type InstallationRow,
  listInstallations,
  revokeInstallation,
} from './installations.js';

let env: DbTestEnv;
let A: string;
let B: string;

const inA = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(A), fn);
const inB = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(B), fn);
const sys = <T>(fn: (s: SystemTx) => Promise<T>) => withSystem(env.db, SYSTEM, fn);
const tokenInput = (appId: string) => {
  const token = generateToken('inst');
  return { appId, tokenHash: hashToken(token), tokenPrefix: tokenPrefix(token) };
};
const app = (name: string, visibility: 'private' | 'public'): CreateAppInput => ({
  name,
  slug: `${name}-${randomUUID()}`,
  visibility,
});
/** Owner role: moderation is not a tenant operation (P1c/P1x own the approval flow). */
const setApproval = (appId: string, status: 'approved' | 'pending' | 'rejected') =>
  env.owner.query('update apps set approval_status = $2 where id = $1', [appId, status]);

beforeAll(async () => {
  env = await setupDbTestEnv();
  A = await createTestWorkspace(env.db, 'alpha');
  B = await createTestWorkspace(env.db, 'bravo');
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

describe('row types hide secrets', () => {
  it('omits app key hash, webhook secret and token hash at the type level', () => {
    expectTypeOf<AppRow>().not.toHaveProperty('appKeyHash');
    expectTypeOf<AppRow>().not.toHaveProperty('statusWebhookSecretEnc');
    expectTypeOf<InstallationRow>().not.toHaveProperty('tokenHash');
    expectTypeOf<CreateAppInput>().not.toHaveProperty('approvalStatus');
    expectTypeOf<InstallationAuthRecord>().toEqualTypeOf<{
      id: string;
      workspaceId: string;
      appId: string;
      status: string;
      grantedTypes: string[] | null;
    }>();
  });
});

describe('apps', () => {
  it('creates an app owned by the workspace and hides secrets', async () => {
    const created = await inA((t) => createApp(t, app('iot', 'private'), SYSTEM_ACTOR));
    expect(created.ownerWorkspaceId).toBe(A);
    expect(created.approvalStatus).toBe('approved');
    expect(created).not.toHaveProperty('appKeyHash');
    expect(created).not.toHaveProperty('statusWebhookSecretEnc');
    expect((await inA((t) => getApp(t, created.id))) ?? {}).not.toHaveProperty('appKeyHash');
    const own = await inA((t) => listOwnApps(t));
    expect(own.map((x) => x.id)).toContain(created.id);
    for (const row of own) {
      expect(row).not.toHaveProperty('appKeyHash');
      expect(row).not.toHaveProperty('statusWebhookSecretEnc');
    }
    expect((await inA((t) => listAuditLog(t, { limit: 1 })))[0]).toMatchObject({
      action: 'app.created',
      targetId: created.id,
      data: { visibility: 'private' },
    });
  });

  it('creates public apps unapproved and ignores an approval field smuggled into the input', async () => {
    const pub = await inA((t) => createApp(t, app('mod', 'public'), SYSTEM_ACTOR));
    expect(pub.approvalStatus).toBe('pending');
    const smuggled = {
      ...app('smuggle', 'public'),
      approvalStatus: 'approved',
    } as unknown as CreateAppInput;
    const sneaky = await inA((t) => createApp(t, smuggled, SYSTEM_ACTOR));
    expect(sneaky.approvalStatus).toBe('pending');
    expect(await inB((t) => getApp(t, sneaky.id))).toBeNull();
    // The owner still sees its own pending app.
    expect((await inA((t) => getApp(t, pub.id)))?.approvalStatus).toBe('pending');
  });

  it('shows approved public apps of others but not private or unapproved ones', async () => {
    const priv = await inA((t) => createApp(t, app('p', 'private'), SYSTEM_ACTOR));
    const pub = await inA((t) => createApp(t, app('q', 'public'), SYSTEM_ACTOR));
    expect(await inB((t) => getApp(t, priv.id))).toBeNull();
    expect(await inB((t) => getApp(t, pub.id))).toBeNull();
    await setApproval(pub.id, 'approved');
    expect((await inB((t) => getApp(t, pub.id)))?.id).toBe(pub.id);
    await setApproval(pub.id, 'rejected');
    expect(await inB((t) => getApp(t, pub.id))).toBeNull();
    const ownB = (await inB((t) => listOwnApps(t))).map((x) => x.id);
    expect(ownB).not.toContain(pub.id);
    expect(ownB).not.toContain(priv.id);
  });

  it('rejects a duplicate slug', async () => {
    const input = app('slug', 'private');
    await inA((t) => createApp(t, input, SYSTEM_ACTOR));
    await expect(inB((t) => createApp(t, input, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoConflictError,
    );
  });
});

describe('installations', () => {
  it('installs a private app in its own workspace and audits it', async () => {
    const own = await inA((t) => createApp(t, app('own', 'private'), SYSTEM_ACTOR));
    const input = tokenInput(own.id);
    const inst = await inA((t) => createInstallation(t, input, SYSTEM_ACTOR));
    expect(inst).not.toHaveProperty('tokenHash');
    expect(inst).toMatchObject({ status: 'active', workspaceId: A, appId: own.id });
    expect((await inA((t) => getInstallation(t, inst.id))) ?? {}).not.toHaveProperty('tokenHash');
    for (const row of await inA((t) => listInstallations(t))) {
      expect(row).not.toHaveProperty('tokenHash');
    }
    const [entry] = await inA((t) => listAuditLog(t, { limit: 1 }));
    expect(entry).toMatchObject({
      action: 'installation.created',
      targetId: inst.id,
      data: { appId: own.id, tokenPrefix: input.tokenPrefix },
    });
    expect(JSON.stringify(entry?.data)).not.toContain(input.tokenHash);
  });

  it('refuses to install another workspace private app', async () => {
    const privB = await inB((t) => createApp(t, app('x', 'private'), SYSTEM_ACTOR));
    await expect(
      inA((t) => createInstallation(t, tokenInput(privB.id), SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    const { rows } = await env.owner.query(
      'select count(*)::int as n from installations where app_id = $1',
      [privB.id],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('refuses an unknown app id', async () => {
    await expect(
      inA((t) => createInstallation(t, tokenInput(randomUUID()), SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('installs an approved public app into another workspace, but not a pending or rejected one', async () => {
    const pubB = await inB((t) => createApp(t, app('pub', 'public'), SYSTEM_ACTOR));
    await expect(
      inA((t) => createInstallation(t, tokenInput(pubB.id), SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await setApproval(pubB.id, 'approved');
    const inst = await inA((t) => createInstallation(t, tokenInput(pubB.id), SYSTEM_ACTOR));
    expect(inst).toMatchObject({ workspaceId: A, appId: pubB.id });
    for (const status of ['pending', 'rejected'] as const) {
      await setApproval(pubB.id, status);
      await expect(
        inA((t) => createInstallation(t, tokenInput(pubB.id), SYSTEM_ACTOR)),
      ).rejects.toBeInstanceOf(RepoNotFoundError);
    }
  });

  it('lets the owner install its own pending public app', async () => {
    const pub = await inA((t) => createApp(t, app('mine', 'public'), SYSTEM_ACTOR));
    const inst = await inA((t) => createInstallation(t, tokenInput(pub.id), SYSTEM_ACTOR));
    expect(inst.workspaceId).toBe(A);
  });

  it('rejects a duplicate token hash', async () => {
    const own = await inA((t) => createApp(t, app('dup', 'private'), SYSTEM_ACTOR));
    const input = tokenInput(own.id);
    await inA((t) => createInstallation(t, input, SYSTEM_ACTOR));
    await expect(inA((t) => createInstallation(t, input, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoConflictError,
    );
  });

  it('isolates installations and revokes idempotently', async () => {
    const own = await inA((t) => createApp(t, app('rv', 'private'), SYSTEM_ACTOR));
    const input = tokenInput(own.id);
    const inst = await inA((t) => createInstallation(t, input, SYSTEM_ACTOR));
    expect(await inB((t) => getInstallation(t, inst.id))).toBeNull();
    expect((await inB((t) => listInstallations(t))).map((i) => i.id)).not.toContain(inst.id);
    await expect(inB((t) => revokeInstallation(t, inst.id, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
    expect((await inA((t) => getInstallation(t, inst.id)))?.status).toBe('active');
    await inA((t) => revokeInstallation(t, inst.id, SYSTEM_ACTOR));
    await inA((t) => revokeInstallation(t, inst.id, SYSTEM_ACTOR));
    const row = await inA((t) => getInstallation(t, inst.id));
    expect(row?.status).toBe('revoked');
    expect(row?.revokedAt).toBeInstanceOf(Date);
    const revokes = (await inA((t) => listAuditLog(t, { limit: 200 }))).filter(
      (a) => a.action === 'installation.revoked' && a.targetId === inst.id,
    );
    expect(revokes).toHaveLength(1);
    expect(revokes[0]?.data).toEqual({
      appId: own.id,
      tokenPrefix: input.tokenPrefix,
      reason: 'workspace',
    });
    expect((await inA((t) => listInstallations(t))).map((i) => i.id)).toContain(inst.id);
  });

  it('records the given revoke reason', async () => {
    const own = await inA((t) => createApp(t, app('rr', 'private'), SYSTEM_ACTOR));
    const inst = await inA((t) => createInstallation(t, tokenInput(own.id), SYSTEM_ACTOR));
    await inA((t) => revokeInstallation(t, inst.id, SYSTEM_ACTOR, { reason: 'app_rejected' }));
    const [entry] = await inA((t) => listAuditLog(t, { limit: 1, action: 'installation.revoked' }));
    expect(entry).toMatchObject({ targetId: inst.id, data: { reason: 'app_rejected' } });
  });

  it('rejects revoking an unknown installation', async () => {
    await expect(
      inA((t) => revokeInstallation(t, randomUUID(), SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});

describe('system lookups', () => {
  it('finds an installation by token hash across workspaces, returning only auth fields', async () => {
    const own = await inB((t) => createApp(t, app('tk', 'private'), SYSTEM_ACTOR));
    const input = { ...tokenInput(own.id), grantedTypes: ['alert'], externalRef: 'ext-1' };
    const inst = await inB((t) => createInstallation(t, input, SYSTEM_ACTOR));
    const found = await sys((s) => findInstallationByTokenHash(s, input.tokenHash));
    expect(found).toEqual({
      id: inst.id,
      workspaceId: B,
      appId: own.id,
      status: 'active',
      grantedTypes: ['alert'],
    });
    expect(await sys((s) => findInstallationByTokenHash(s, hashToken('unknown')))).toBeNull();
  });

  it('returns a revoked installation with its status so callers can tell revoked from unknown', async () => {
    const own = await inA((t) => createApp(t, app('tr', 'private'), SYSTEM_ACTOR));
    const input = tokenInput(own.id);
    const inst = await inA((t) => createInstallation(t, input, SYSTEM_ACTOR));
    await inA((t) => revokeInstallation(t, inst.id, SYSTEM_ACTOR));
    expect(await sys((s) => findInstallationByTokenHash(s, input.tokenHash))).toMatchObject({
      id: inst.id,
      status: 'revoked',
    });
  });

  it('resolves the workspace of every entity kind', async () => {
    const own = await inA((t) => createApp(t, app('rs', 'private'), SYSTEM_ACTOR));
    const inst = await inA((t) => createInstallation(t, tokenInput(own.id), SYSTEM_ACTOR));
    const conn = await inA((t) =>
      createConnection(
        t,
        { platform: 'telegram', kind: 'shared_bot', displayName: 'c', config: null },
        SYSTEM_ACTOR,
      ),
    );
    const dest = await inA((t) =>
      createDestination(t, { connectionId: conn.id, kind: 'group', externalId: 'g1', name: 'g1' }),
    );
    const eventId = randomUUID();
    const digestId = randomUUID();
    const deliveryId = randomUUID();
    await env.owner.query(
      `insert into events (id, workspace_id, installation_id, idempotency_key, type, severity, message)
       values ($1, $2, $3, 'k1', 'generic', 'info', '{"title":"t"}')`,
      [eventId, A, inst.id],
    );
    await env.owner.query(
      `insert into digests (id, workspace_id, destination_id, connection_id, window_start, window_end)
       values ($1, $2, $3, $4, now(), now() + interval '1 hour')`,
      [digestId, A, dest.id, conn.id],
    );
    await env.owner.query(
      `insert into deliveries (id, workspace_id, event_id, destination_id, connection_id)
       values ($1, $2, $3, $4, $5)`,
      [deliveryId, A, eventId, dest.id, conn.id],
    );
    const cases: Array<[TenantEntityKind, string]> = [
      ['event', eventId],
      ['delivery', deliveryId],
      ['digest', digestId],
      ['connection', conn.id],
      ['installation', inst.id],
    ];
    for (const [kind, id] of cases) {
      expect(await sys((s) => resolveWorkspaceOf(s, kind, id))).toBe(A);
      expect(await sys((s) => resolveWorkspaceOf(s, kind, id.toUpperCase()))).toBe(A);
      expect(await sys((s) => resolveWorkspaceOf(s, kind, randomUUID()))).toBeNull();
      expect(await sys((s) => resolveWorkspaceOf(s, kind, 'not-a-uuid'))).toBeNull();
      expect(await sys((s) => resolveWorkspaceOf(s, kind, ''))).toBeNull();
    }
  });

  it('lists all workspaces', async () => {
    const ids = (await sys((s) => listWorkspaces(s))).map((w) => w.id);
    expect(ids).toEqual(expect.arrayContaining([A, B]));
  });

  it('reads and writes instance settings and audits each write as settings.updated', async () => {
    const userId = randomUUID();
    await sys((s) => setInstanceSetting(s, 'registration', 'invite', SYSTEM_ACTOR));
    const { rows: first } = await env.owner.query(
      "select updated_by from instance_settings where key = 'registration'",
    );
    expect(first[0]?.updated_by).toBeNull();
    await sys((s) => setInstanceSetting(s, 'registration', 'open', { kind: 'user', userId }));
    expect(await sys((s) => getInstanceSetting(s, 'registration'))).toBe('open');
    expect(await sys((s) => getInstanceSetting(s, 'missing'))).toBeNull();
    const { rows } = await env.owner.query(
      "select updated_by from instance_settings where key = 'registration'",
    );
    expect(rows[0]?.updated_by).toBe(userId);
    const audit = await sys((s) => listSystemAuditLog(s, { action: 'settings.updated' }));
    expect(
      audit.slice(0, 2).map((a) => ({
        workspaceId: a.workspaceId,
        targetId: a.targetId,
        data: a.data,
        actorUserId: a.actorUserId,
      })),
    ).toEqual([
      {
        workspaceId: null,
        targetId: 'registration',
        data: { keys: ['registration'] },
        actorUserId: userId,
      },
      {
        workspaceId: null,
        targetId: 'registration',
        data: { keys: ['registration'] },
        actorUserId: null,
      },
    ]);
  });

  it('stores structured values and never writes the value to the audit log', async () => {
    const value = { smtpHost: 'mail.example', note: 'do-not-audit-me' };
    await sys((s) => setInstanceSetting(s, 'smtp', value, SYSTEM_ACTOR));
    expect(await sys((s) => getInstanceSetting(s, 'smtp'))).toEqual(value);
    const [entry] = await sys((s) =>
      listSystemAuditLog(s, { limit: 1, action: 'settings.updated' }),
    );
    expect(entry?.data).toEqual({ keys: ['smtp'] });
    expect(JSON.stringify(entry)).not.toContain('do-not-audit-me');
  });
});

/** Expects a raw query to fail with SQLSTATE 42501 (unmapped by design, so it surfaces loudly). */
async function expectInsufficientPrivilege(p: Promise<unknown>): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'query should have been rejected').not.toBeNull();
  expect(pgErrorCode(err)).toBe('42501');
}

describe('database guard on app approval (raw q(t), bypassing the repository)', () => {
  it('rejects a tenant self-approving its own pending public app', async () => {
    const pub = await inA((t) => createApp(t, app('selfapprove', 'public'), SYSTEM_ACTOR));
    await expectInsufficientPrivilege(
      inA((t) => q(t).update(apps).set({ approvalStatus: 'approved' }).where(eq(apps.id, pub.id))),
    );
    expect((await inA((t) => getApp(t, pub.id)))?.approvalStatus).toBe('pending');
    expect(await inB((t) => getApp(t, pub.id))).toBeNull();
  });

  it('resets approval to pending when a tenant flips a private app to public', async () => {
    const priv = await inA((t) => createApp(t, app('flip', 'private'), SYSTEM_ACTOR));
    expect(priv.approvalStatus).toBe('approved');
    await inA((t) => q(t).update(apps).set({ visibility: 'public' }).where(eq(apps.id, priv.id)));
    expect(await inA((t) => getApp(t, priv.id))).toMatchObject({
      visibility: 'public',
      approvalStatus: 'pending',
    });
    expect(await inB((t) => getApp(t, priv.id))).toBeNull();
    await expectInsufficientPrivilege(
      inA((t) =>
        q(t)
          .update(apps)
          .set({ visibility: 'private', approvalStatus: 'approved' })
          .where(eq(apps.id, priv.id)),
      ),
    );
  });

  it('rejects flipping to public and approving in one statement', async () => {
    const priv = await inA((t) => createApp(t, app('flip2', 'private'), SYSTEM_ACTOR));
    await inA((t) => q(t).update(apps).set({ visibility: 'public' }).where(eq(apps.id, priv.id)));
    await inA((t) => q(t).update(apps).set({ visibility: 'private' }).where(eq(apps.id, priv.id)));
    await expectInsufficientPrivilege(
      inA((t) =>
        q(t)
          .update(apps)
          .set({ visibility: 'public', approvalStatus: 'approved' })
          .where(eq(apps.id, priv.id)),
      ),
    );
  });

  it('keeps a rejected status when the app goes private and back to public', async () => {
    const pub = await inA((t) => createApp(t, app('rej', 'public'), SYSTEM_ACTOR));
    await sys((s) =>
      q(s).update(apps).set({ approvalStatus: 'rejected' }).where(eq(apps.id, pub.id)),
    );
    await inA((t) => q(t).update(apps).set({ visibility: 'private' }).where(eq(apps.id, pub.id)));
    await inA((t) => q(t).update(apps).set({ visibility: 'public' }).where(eq(apps.id, pub.id)));
    expect((await inA((t) => getApp(t, pub.id)))?.approvalStatus).toBe('rejected');
  });

  it('rejects a raw insert of a public app that starts approved, explicitly or by column default', async () => {
    for (const approvalStatus of ['approved', undefined] as const) {
      const id = randomUUID();
      await expectInsufficientPrivilege(
        inA((t) =>
          q(t)
            .insert(apps)
            .values({
              id,
              ownerWorkspaceId: A,
              name: 'raw',
              slug: `raw-${id}`,
              visibility: 'public',
              ...(approvalStatus ? { approvalStatus } : {}),
            }),
        ),
      );
    }
  });

  it('lets system mode approve an app, which then becomes visible to other workspaces', async () => {
    const pub = await inA((t) => createApp(t, app('sysapprove', 'public'), SYSTEM_ACTOR));
    await sys((s) =>
      q(s).update(apps).set({ approvalStatus: 'approved' }).where(eq(apps.id, pub.id)),
    );
    expect((await inB((t) => getApp(t, pub.id)))?.approvalStatus).toBe('approved');
    // A tenant still cannot take the approval back either.
    await expectInsufficientPrivilege(
      inA((t) => q(t).update(apps).set({ approvalStatus: 'pending' }).where(eq(apps.id, pub.id))),
    );
  });
});

describe('instance_settings is system only', () => {
  it('hides rows from tenant transactions and rejects tenant writes, while withSystem works', async () => {
    await sys((s) => setInstanceSetting(s, 'tenant-probe', 'x', SYSTEM_ACTOR));
    expect(await inA((t) => q(t).select().from(instanceSettings))).toEqual([]);
    await expectInsufficientPrivilege(
      inA((t) => q(t).insert(instanceSettings).values({ key: 'from-tenant', value: 'y' })),
    );
    const updated = await inA((t) =>
      q(t)
        .update(instanceSettings)
        .set({ value: 'hijacked' })
        .where(eq(instanceSettings.key, 'tenant-probe'))
        .returning(),
    );
    expect(updated).toEqual([]);
    expect(await sys((s) => getInstanceSetting(s, 'tenant-probe'))).toBe('x');
    expect(await sys((s) => getInstanceSetting(s, 'from-tenant'))).toBeNull();
  });
});

describe('instance setting values', () => {
  it('rejects undefined before any SQL', async () => {
    await expect(
      sys((s) => setInstanceSetting(s, 'undef', undefined, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(InvalidSettingValueError);
    const audit = await sys((s) =>
      listSystemAuditLog(s, { action: 'settings.updated', limit: 200 }),
    );
    expect(audit.some((a) => a.targetId === 'undef')).toBe(false);
  });

  it('stores a JSON null, which reads back like a missing key', async () => {
    await sys((s) => setInstanceSetting(s, 'json-null', null, SYSTEM_ACTOR));
    const { rows } = await env.owner.query(
      "select value is null as sql_null, value = 'null'::jsonb as json_null from instance_settings where key = 'json-null'",
    );
    expect(rows[0]).toEqual({ sql_null: false, json_null: true });
    expect(await sys((s) => getInstanceSetting(s, 'json-null'))).toBeNull();
  });
});
