import { FakeClock, newId } from '@owlwire/core';
import { createKeyring, generateKek } from '@owlwire/crypto';
import {
  getWorkspace,
  listMembers,
  listPendingInvitations,
  type OwlwireDb,
  openDatabase,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { migrateAll } from '@owlwire/db/migrate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../tenant-database.js';
import {
  listAuditActions,
  seedCommunityWorkspace,
  seedInvitation,
  seedMembership,
} from './index.js';

let tdb: TestDatabase;
let owner: pg.Pool;
let db: OwlwireDb;
const clock = new FakeClock(new Date('2026-10-12T09:00:00Z'));

beforeAll(async () => {
  tdb = await startTestDatabase({ migrate: migrateAll });
  owner = new pg.Pool({ connectionString: tdb.ownerUrl });
  db = openDatabase({ url: tdb.appUrl, keyring: createKeyring(generateKek(1)), clock });
}, 120_000);
afterAll(async () => {
  await db?.close();
  await owner?.end();
  await tdb?.stop();
});

async function user(): Promise<string> {
  const id = newId();
  await owner.query('insert into auth_user (id, name, email) values ($1, $2, $3)', [
    id,
    'Fixture user',
    `${id}@fixture.test`,
  ]);
  return id;
}

describe('@owlwire/testing/fixtures', () => {
  it('seeds a community workspace with its owner, members, an invitation and audit rows', async () => {
    const owner = await user();
    const member = await user();
    const ws = await seedCommunityWorkspace(db, owner);
    await seedMembership(db, ws, member, 'admin');
    const email = `Fixture-${newId()}@X.test`;
    const { id } = await seedInvitation(db, {
      workspaceId: ws,
      email,
      tokenHash: `fixture-${newId()}`,
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    await withTenant(db, tenantScope(ws), async (t) => {
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
    expect((await listAuditActions(db, ws)).sort()).toEqual(
      ['invitation.created', 'member.added', 'member.added', 'workspace.created'].sort(),
    );
  });

  it('names the workspace when asked', async () => {
    const ws = await seedCommunityWorkspace(db, await user(), 'Named');
    expect((await withTenant(db, tenantScope(ws), (t) => getWorkspace(t)))?.name).toBe('Named');
  });
});
