import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { auditLog } from '../schema/index.js';
import { SYSTEM, tenantScope, withSystem, withTenant } from '../scope.js';
import {
  type AuditAction,
  AuditDataError,
  listAuditLog,
  listSystemAuditLog,
  SYSTEM_ACTOR,
  writeAudit,
} from './audit.js';
import { q } from './context.js';

let env: DbTestEnv;
const WS_A = randomUUID();
const WS_B = randomUUID();

beforeAll(async () => {
  env = await setupDbTestEnv();
  for (const id of [WS_A, WS_B]) {
    await env.owner.query(
      "insert into workspaces (id, name, slug, kind) values ($1, $2, $2, 'community')",
      [id, `ws-${id}`],
    );
  }
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

describe('writeAudit / listAuditLog', () => {
  it('writes entries with actor columns and lists newest first', async () => {
    const userId = randomUUID();
    await withTenant(env.db, tenantScope(WS_A), (t) =>
      writeAudit(t, {
        action: 'rule.created',
        actor: { kind: 'user', userId },
        targetType: 'rule',
        targetId: 'r1',
        data: { types: ['*'] },
      }),
    );
    env.clock.advance(1000);
    await withTenant(env.db, tenantScope(WS_A), (t) =>
      writeAudit(t, {
        action: 'rule.deleted',
        actor: SYSTEM_ACTOR,
        targetType: 'rule',
        targetId: 'r1',
      }),
    );
    const rows = await withTenant(env.db, tenantScope(WS_A), (t) => listAuditLog(t));
    expect(rows.map((r) => r.action)).toEqual(['rule.deleted', 'rule.created']);
    expect(rows[1]).toMatchObject({
      workspaceId: WS_A,
      actorUserId: userId,
      actorInstallationId: null,
      data: { types: ['*'] },
    });
    expect(rows[0]?.createdAt.toISOString()).toBe('2026-10-12T09:00:01.000Z');
  });

  it('does not show entries of another workspace', async () => {
    const rows = await withTenant(env.db, tenantScope(WS_B), (t) => listAuditLog(t));
    expect(rows).toEqual([]);
  });

  it('never returns the other tenant rows in either direction (R121)', async () => {
    await withTenant(env.db, tenantScope(WS_B), (t) =>
      writeAudit(t, {
        action: 'member.added',
        actor: SYSTEM_ACTOR,
        targetType: 'member',
        targetId: 'b-only',
      }),
    );
    const a = await withTenant(env.db, tenantScope(WS_A), (t) => listAuditLog(t, { limit: 200 }));
    const b = await withTenant(env.db, tenantScope(WS_B), (t) => listAuditLog(t, { limit: 200 }));
    expect(a.every((r) => r.workspaceId === WS_A)).toBe(true);
    expect(a.some((r) => r.targetId === 'b-only')).toBe(false);
    expect(b.every((r) => r.workspaceId === WS_B)).toBe(true);
    expect(b.some((r) => r.targetId === 'r1')).toBe(false);
  });

  it('RLS alone confines an unfiltered select to the tenant rows', async () => {
    const seen = await withTenant(env.db, tenantScope(WS_A), (t) =>
      q(t).select({ workspaceId: auditLog.workspaceId }).from(auditLog),
    );
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((r) => r.workspaceId === WS_A)).toBe(true);
    const total = await env.owner.query('select count(*)::int as n from audit_log');
    expect(total.rows[0].n).toBeGreaterThan(seen.length);
  });

  it('rejects secret-looking data and writes nothing', async () => {
    await expect(
      withTenant(env.db, tenantScope(WS_B), (t) =>
        writeAudit(t, {
          action: 'connection.created',
          actor: SYSTEM_ACTOR,
          targetType: 'connection',
          targetId: 'c1',
          data: { connection: { botToken: '123:abc' } },
        }),
      ),
    ).rejects.toBeInstanceOf(AuditDataError);
    const rows = await withTenant(env.db, tenantScope(WS_B), (t) =>
      listAuditLog(t, { action: 'connection.created' }),
    );
    expect(rows).toEqual([]);
  });

  it('rejects unknown actions', async () => {
    await expect(
      withTenant(env.db, tenantScope(WS_B), (t) =>
        writeAudit(t, {
          action: 'made.up' as AuditAction,
          actor: SYSTEM_ACTOR,
          targetType: 'rule',
          targetId: 'x',
        }),
      ),
    ).rejects.toBeInstanceOf(AuditDataError);
  });

  it('keeps instance-level entries hidden from tenants', async () => {
    await withSystem(env.db, SYSTEM, (s) =>
      writeAudit(s, {
        workspaceId: null,
        action: 'keys.legacy_secrets_upgraded',
        actor: SYSTEM_ACTOR,
        targetType: 'keys',
        targetId: 'connections',
        data: { upgraded: 0, failed: 0 },
      }),
    );
    const rows = await withTenant(env.db, tenantScope(WS_A), (t) =>
      listAuditLog(t, { limit: 200 }),
    );
    expect(rows.some((r) => r.workspaceId === null)).toBe(false);
    expect(rows.some((r) => r.action === 'keys.legacy_secrets_upgraded')).toBe(false);
    const system = await withSystem(env.db, SYSTEM, (s) => listSystemAuditLog(s));
    expect(system.map((r) => r.action)).toEqual(['keys.legacy_secrets_upgraded']);
    expect(system.every((r) => r.workspaceId === null)).toBe(true);
  });

  it('filters by action', async () => {
    const rows = await withTenant(env.db, tenantScope(WS_A), (t) =>
      listAuditLog(t, { action: 'rule.created' }),
    );
    expect(rows.map((r) => r.action)).toEqual(['rule.created']);
  });

  it('paginates with a keyset cursor', async () => {
    for (let i = 0; i < 3; i++) {
      env.clock.advance(1000);
      await withTenant(env.db, tenantScope(WS_B), (t) =>
        writeAudit(t, {
          action: 'rule.updated',
          actor: SYSTEM_ACTOR,
          targetType: 'rule',
          targetId: `p${i}`,
        }),
      );
    }
    const first = await withTenant(env.db, tenantScope(WS_B), (t) => listAuditLog(t, { limit: 2 }));
    expect(first.map((r) => r.targetId)).toEqual(['p2', 'p1']);
    const last = first[1];
    if (!last) throw new Error('expected two rows');
    const second = await withTenant(env.db, tenantScope(WS_B), (t) =>
      listAuditLog(t, { limit: 2, before: { createdAt: last.createdAt, id: last.id } }),
    );
    expect(second.map((r) => r.targetId)).toEqual(['p0', 'b-only']);
  });
});

describe('keyset pagination with sub-millisecond timestamps', () => {
  it('neither skips nor duplicates rows written with now()', async () => {
    const ws = randomUUID();
    await env.owner.query(
      "insert into workspaces (id, name, slug, kind) values ($1, $2, $2, 'community')",
      [ws, `ws-${ws}`],
    );
    // One statement: now() is identical for every row, and ids order them. Plus rows a few microseconds apart.
    await env.owner.query(
      `insert into audit_log (id, workspace_id, action, target_type, target_id, created_at)
       select gen_random_uuid(), $1, 'rule.updated', 'rule', 'm' || g,
              timestamptz '2026-10-12 10:00:00.123456+00' + (g % 3) * interval '137 microseconds'
       from generate_series(1, 12) g`,
      [ws],
    );
    const seen: string[] = [];
    let before: { createdAt: Date; id: string } | undefined;
    for (let i = 0; i < 20; i++) {
      const page = await withTenant(env.db, tenantScope(ws), (t) =>
        listAuditLog(t, { limit: 5, before }),
      );
      if (page.length === 0) break;
      seen.push(...page.map((r) => r.targetId));
      const last = page[page.length - 1];
      if (!last) break;
      before = { createdAt: last.createdAt, id: last.id };
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });
});
