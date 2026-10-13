import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { createTestWorkspace } from '../__test__/fixtures.js';
import { RepoConflictError, RepoNotFoundError } from '../errors.js';
import { type TenantTx, tenantScope, withTenant } from '../scope.js';
import {
  createAudience,
  deleteAudience,
  expandAudiences,
  listAudienceMembers,
  listAudiences,
  setAudienceMembers,
} from './audiences.js';
import { listAuditLog, SYSTEM_ACTOR } from './audit.js';
import { createConnection, deleteConnection } from './connections.js';
import { createDestination } from './destinations.js';

let env: DbTestEnv;
let A: string;
let B: string;
let destA1: string;
let destA2: string;
let destB1: string;

const inA = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(A), fn);
const inB = <T>(fn: (t: TenantTx) => Promise<T>) => withTenant(env.db, tenantScope(B), fn);

async function makeConnection(t: TenantTx): Promise<string> {
  const conn = await createConnection(
    t,
    { platform: 'telegram', kind: 'shared_bot', displayName: 'c', config: null },
    SYSTEM_ACTOR,
  );
  return conn.id;
}

async function makeDestination(t: TenantTx, externalId: string, connectionId?: string) {
  const cid = connectionId ?? (await makeConnection(t));
  const dest = await createDestination(t, {
    connectionId: cid,
    kind: 'group',
    externalId,
    name: externalId,
  });
  return dest.id;
}

/** Owner-role seed: a rule that targets the given audience. */
async function seedRuleTarget(workspaceId: string, audienceId: string): Promise<void> {
  const appId = randomUUID();
  const installationId = randomUUID();
  const ruleId = randomUUID();
  await env.owner.query(
    "insert into apps (id, owner_workspace_id, name, slug, visibility) values ($1, $2, 'seed app', $3, 'private')",
    [appId, workspaceId, `app-${appId}`],
  );
  await env.owner.query(
    "insert into installations (id, app_id, workspace_id, token_hash, token_prefix) values ($1, $2, $3, $4, 'ow_inst_test')",
    [installationId, appId, workspaceId, `hash-${installationId}`],
  );
  await env.owner.query(
    "insert into rules (id, workspace_id, installation_id, name, types) values ($1, $2, $3, 'r', array['*'])",
    [ruleId, workspaceId, installationId],
  );
  await env.owner.query(
    'insert into rule_targets (id, workspace_id, rule_id, audience_id) values ($1, $2, $3, $4)',
    [randomUUID(), workspaceId, ruleId, audienceId],
  );
}

beforeAll(async () => {
  env = await setupDbTestEnv();
  A = await createTestWorkspace(env.db, 'alpha');
  B = await createTestWorkspace(env.db, 'bravo');
  destA1 = await inA((t) => makeDestination(t, 'a1'));
  destA2 = await inA((t) => makeDestination(t, 'a2'));
  destB1 = await inB((t) => makeDestination(t, 'b1'));
}, 120_000);

afterAll(async () => {
  await env?.stop();
});

describe('audiences', () => {
  it('creates, lists and audits', async () => {
    const aud = await inA((t) => createAudience(t, { name: 'Yönetim' }, SYSTEM_ACTOR));
    expect((await inA((t) => listAudiences(t))).map((a) => a.name)).toContain('Yönetim');
    expect((await inA((t) => listAuditLog(t, { limit: 1 })))[0]).toMatchObject({
      action: 'audience.created',
      targetId: aud.id,
    });
  });

  it('rejects duplicate names in the same workspace but allows them across workspaces', async () => {
    await inA((t) => createAudience(t, { name: 'dup' }, SYSTEM_ACTOR));
    await expect(
      inA((t) => createAudience(t, { name: 'dup' }, SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoConflictError);
    await expect(
      inB((t) => createAudience(t, { name: 'dup' }, SYSTEM_ACTOR)),
    ).resolves.toMatchObject({
      name: 'dup',
    });
  });

  it('replaces members, removes duplicates and audits counts', async () => {
    const aud = await inA((t) => createAudience(t, { name: 'members' }, SYSTEM_ACTOR));
    await inA((t) => setAudienceMembers(t, aud.id, [destA1, destA1, destA2], SYSTEM_ACTOR));
    expect((await inA((t) => listAudienceMembers(t, aud.id))).sort()).toEqual(
      [destA1, destA2].sort(),
    );
    await inA((t) => setAudienceMembers(t, aud.id, [destA2], SYSTEM_ACTOR));
    expect(await inA((t) => listAudienceMembers(t, aud.id))).toEqual([destA2]);
    expect((await inA((t) => listAuditLog(t, { limit: 1 })))[0]).toMatchObject({
      action: 'audience.members_changed',
      data: { before: 2, after: 1 },
    });
    await inA((t) => setAudienceMembers(t, aud.id, [], SYSTEM_ACTOR));
    expect(await inA((t) => listAudienceMembers(t, aud.id))).toEqual([]);
  });

  it('rejects members from another workspace and keeps the previous set', async () => {
    const aud = await inB((t) => createAudience(t, { name: 'foreign' }, SYSTEM_ACTOR));
    await inB((t) => setAudienceMembers(t, aud.id, [destB1], SYSTEM_ACTOR));
    await expect(
      inB((t) => setAudienceMembers(t, aud.id, [destB1, destA1], SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    expect(await inB((t) => listAudienceMembers(t, aud.id))).toEqual([destB1]);
  });

  it('rejects unknown destination ids and keeps the previous set', async () => {
    const aud = await inA((t) => createAudience(t, { name: 'unknown' }, SYSTEM_ACTOR));
    await inA((t) => setAudienceMembers(t, aud.id, [destA1], SYSTEM_ACTOR));
    await expect(
      inA((t) => setAudienceMembers(t, aud.id, [destA2, randomUUID()], SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    expect(await inA((t) => listAudienceMembers(t, aud.id))).toEqual([destA1]);
  });

  it('hides another workspace audience entirely', async () => {
    const aud = await inA((t) => createAudience(t, { name: 'hidden' }, SYSTEM_ACTOR));
    await inA((t) => setAudienceMembers(t, aud.id, [destA1], SYSTEM_ACTOR));
    await expect(inB((t) => listAudienceMembers(t, aud.id))).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
    await expect(
      inB((t) => setAudienceMembers(t, aud.id, [destB1], SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(inB((t) => deleteAudience(t, aud.id, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoNotFoundError,
    );
    expect((await inB((t) => expandAudiences(t, [aud.id]))).size).toBe(0);
    expect((await inB((t) => listAudiences(t))).map((a) => a.id)).not.toContain(aud.id);
    expect(await inA((t) => listAudienceMembers(t, aud.id))).toEqual([destA1]);
    expect((await inA((t) => listAudiences(t))).map((a) => a.id)).toContain(aud.id);
  });

  it('expands several audiences into a map', async () => {
    const x = await inA((t) => createAudience(t, { name: 'x' }, SYSTEM_ACTOR));
    const y = await inA((t) => createAudience(t, { name: 'y' }, SYSTEM_ACTOR));
    await inA((t) => setAudienceMembers(t, x.id, [destA1], SYSTEM_ACTOR));
    const map = await inA((t) => expandAudiences(t, [x.id, y.id, randomUUID()]));
    expect(map.get(x.id)).toEqual([destA1]);
    expect(map.get(y.id)).toEqual([]);
    expect(map.size).toBe(2);
    expect((await inA((t) => expandAudiences(t, []))).size).toBe(0);
  });

  it('deletes an audience that no rule uses', async () => {
    const aud = await inA((t) => createAudience(t, { name: 'gone' }, SYSTEM_ACTOR));
    await inA((t) => setAudienceMembers(t, aud.id, [destA1], SYSTEM_ACTOR));
    await inA((t) => deleteAudience(t, aud.id, SYSTEM_ACTOR));
    expect((await inA((t) => listAudiences(t))).map((a) => a.id)).not.toContain(aud.id);
    expect((await inA((t) => listAuditLog(t, { limit: 1 })))[0]).toMatchObject({
      action: 'audience.deleted',
      targetId: aud.id,
    });
  });

  it('refuses to delete an audience that a rule targets', async () => {
    const aud = await inA((t) => createAudience(t, { name: 'targeted' }, SYSTEM_ACTOR));
    await seedRuleTarget(A, aud.id);
    await expect(inA((t) => deleteAudience(t, aud.id, SYSTEM_ACTOR))).rejects.toBeInstanceOf(
      RepoConflictError,
    );
    expect((await inA((t) => listAudiences(t))).map((a) => a.id)).toContain(aud.id);
  });
});

describe('audiences and soft-deleted destinations', () => {
  it('rejects a soft-deleted destination and hides it from list and expand', async () => {
    const conn = await inA((t) => makeConnection(t));
    const dead = await inA((t) => makeDestination(t, 'dead', conn));
    const aud = await inA((t) => createAudience(t, { name: 'softdel' }, SYSTEM_ACTOR));
    await inA((t) => setAudienceMembers(t, aud.id, [destA1, dead], SYSTEM_ACTOR));
    await inA((t) => deleteConnection(t, conn, SYSTEM_ACTOR));
    expect(await inA((t) => listAudienceMembers(t, aud.id))).toEqual([destA1]);
    expect((await inA((t) => expandAudiences(t, [aud.id]))).get(aud.id)).toEqual([destA1]);
    await expect(
      inA((t) => setAudienceMembers(t, aud.id, [destA1, dead], SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    expect(await inA((t) => listAudienceMembers(t, aud.id))).toEqual([destA1]);
  });

  it('hides a member whose destination row alone is soft-deleted, even if the stale membership remains', async () => {
    const aud = await inA((t) => createAudience(t, { name: 'rowonly' }, SYSTEM_ACTOR));
    const d = await inA((t) => makeDestination(t, 'rowonly'));
    await inA((t) => setAudienceMembers(t, aud.id, [d, destA1], SYSTEM_ACTOR));
    await env.owner.query('update destinations set deleted_at = now() where id = $1', [d]);
    expect(await inA((t) => listAudienceMembers(t, aud.id))).toEqual([destA1]);
    expect((await inA((t) => expandAudiences(t, [aud.id]))).get(aud.id)).toEqual([destA1]);
    await expect(
      inA((t) => setAudienceMembers(t, aud.id, [d], SYSTEM_ACTOR)),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });
});

describe('audiences concurrency', () => {
  it('serialises concurrent replacements: the final set is exactly one input', async () => {
    const aud = await inA((t) => createAudience(t, { name: 'race' }, SYSTEM_ACTOR));
    const d3 = await inA((t) => makeDestination(t, 'r3'));
    const setX = [destA1, destA2];
    const setY = [d3, destA2];
    await Promise.all([
      inA((t) => setAudienceMembers(t, aud.id, setX, SYSTEM_ACTOR)),
      inA((t) => setAudienceMembers(t, aud.id, setY, SYSTEM_ACTOR)),
    ]);
    const got = (await inA((t) => listAudienceMembers(t, aud.id))).sort();
    expect([[...setX].sort(), [...setY].sort()]).toContainEqual(got);
  });

  it('does not deadlock or leave a visible member when racing deleteConnection', async () => {
    for (let i = 0; i < 5; i++) {
      const conn = await inA((t) => makeConnection(t));
      const d = await inA((t) => makeDestination(t, `race-${i}`, conn));
      const aud = await inA((t) => createAudience(t, { name: `race-del-${i}` }, SYSTEM_ACTOR));
      const results = await Promise.allSettled([
        inA((t) => setAudienceMembers(t, aud.id, [d], SYSTEM_ACTOR)),
        inA((t) => deleteConnection(t, conn, SYSTEM_ACTOR)),
      ]);
      expect(results[1]?.status).toBe('fulfilled');
      if (results[0]?.status === 'rejected') {
        expect(results[0].reason).toBeInstanceOf(RepoNotFoundError);
      }
      expect(await inA((t) => listAudienceMembers(t, aud.id))).toEqual([]);
      const stale = await env.owner.query('select 1 from audience_members where audience_id = $1', [
        aud.id,
      ]);
      expect(stale.rowCount).toBe(0);
    }
  });
});
