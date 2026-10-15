import { FakeClock } from '@owlwire/core';
import { createKeyring, generateKek, type Keyring } from '@owlwire/crypto';
import { startTestDatabase, type TestDatabase } from '@owlwire/testing';
import pg from 'pg';
import { type OwlwireDb, openDatabase } from '../handle.js';
import { migrateAll } from '../migrate-all.js';

export interface DbTestEnv {
  tdb: TestDatabase;
  /** Owner role pool: fixtures and assertions only, never repo calls. */
  owner: pg.Pool;
  clock: FakeClock;
  keyring: Keyring;
  /** Opened with the app role (owlwire_app), so RLS applies. */
  db: OwlwireDb;
  /** Opened with the auth role (owlwire_auth): the auth adapter and the auth_user system functions. */
  authDb: OwlwireDb;
  open(keyring: Keyring): OwlwireDb;
  stop(): Promise<void>;
}

export async function setupDbTestEnv(): Promise<DbTestEnv> {
  const tdb = await startTestDatabase({ migrate: migrateAll });
  const clock = new FakeClock(new Date('2026-10-12T09:00:00Z'));
  const keyring = createKeyring(generateKek(1));
  const opened: OwlwireDb[] = [];
  const open = (k: Keyring): OwlwireDb => {
    const handle = openDatabase({ url: tdb.appUrl, keyring: k, clock });
    opened.push(handle);
    return handle;
  };
  const db = open(keyring);
  const authDb = openDatabase({ url: tdb.authUrl, keyring, clock });
  opened.push(authDb);
  const owner = new pg.Pool({ connectionString: tdb.ownerUrl });
  return {
    tdb,
    owner,
    clock,
    keyring,
    db,
    authDb,
    open,
    stop: async () => {
      for (const handle of opened) await handle.close();
      await owner.end();
      await tdb.stop();
    },
  };
}
