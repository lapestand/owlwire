import { newId } from '@owlwire/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from '../__test__/env.js';
import { listPendingInvitations } from '../repos/invitations.js';
import { listMembers } from '../repos/memberships.js';
import { getWorkspace } from '../repos/workspaces.js';
import { tenantScope, withTenant } from '../scope.js';
import {
  listAuditActions,
  seedCommunityWorkspace,
  seedInvitation,
  seedMembership,
} from './index.js';

let env: DbTestEnv;

beforeAll(async () => {
  env = await setupDbTestEnv();
}, 120_000);
afterAll(async () => {
  await env?.stop();
});

async function user(): Promise<string> {
  const id = newId();
  await env.owner.query('insert into auth_user (id, name, email) values ($1, $2, $3)', [
    id,
    'Fixture user',
    `${id}@fixture.test`,
  ]);
  return id;
}

describe('@owlwire/db/fixtures', () => {
  it('seeds a community workspace with its owner, members, an invitation and audit rows', async () => {
    const owner = await user();
    const member = await user();
    const ws = await seedCommunityWorkspace(env.db, owner);
    await seedMembership(env.db, ws, member, 'admin');
    const email = `Fixture-${newId()}@X.test`;
    const { id } = await seedInvitation(env.db, {
      workspaceId: ws,
      email,
      tokenHash: `fixture-${newId()}`,
      expiresAt: new Date(env.clock.now().getTime() + 60_000),
    });
    await withTenant(env.db, tenantScope(ws), async (t) => {
      expect(await getWorkspace(t)).toMatchObject({
        id: ws,
        name: 'Test Alliance',
        kind: 'community',
      });
      expect((await listMembers(t)).map((m) => [m.userId, m.role])).toEqual([
        [owner, 'owner'],
        [member, 'admin'],
      ]);
      expect(await listPendingInvitations(t)).toEqual([
        expect.objectContaining({
          id,
          email: email.toLowerCase(),
          role: 'member',
          invitedBy: null,
        }),
      ]);
    });
    expect((await listAuditActions(env.db, ws)).sort()).toEqual(
      ['invitation.created', 'member.added', 'member.added', 'workspace.created'].sort(),
    );
  });

  it('names the workspace when asked', async () => {
    const ws = await seedCommunityWorkspace(env.db, await user(), 'Named');
    expect((await withTenant(env.db, tenantScope(ws), (t) => getWorkspace(t)))?.name).toBe('Named');
  });
});
