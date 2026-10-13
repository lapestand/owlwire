import type { Clock } from '@owlwire/core';
import type { Keyring } from '@owlwire/crypto';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { createPool } from './client.js';
import * as schema from './schema/index.js';

export type Drizzle = NodePgDatabase<typeof schema>;
export type DrizzleTx = Parameters<Parameters<Drizzle['transaction']>[0]>[0];

export interface DbInternals {
  readonly drizzle: Drizzle;
  readonly pool: pg.Pool;
  readonly keyring: Keyring;
  readonly clock: Clock;
}

export interface OpenDatabaseOptions {
  url: string;
  keyring: Keyring;
  clock: Clock;
  maxConnections?: number;
  /** Boşta/kullanımdaki istemci hataları (sunucu yeniden başladı vb.); verilmezse yutulur, süreç düşmez. */
  onPoolError?: (err: Error) => void;
}

let readInternals: (db: OwlwireDb) => DbInternals;

/** Opak tutamaç: Drizzle'a paket dışından erişilemez. */
export class OwlwireDb {
  readonly #internals: DbInternals;
  #closing: Promise<void> | undefined;

  constructor(internals: DbInternals) {
    this.#internals = internals;
  }

  static {
    readInternals = (db) => db.#internals;
  }

  /** İdempotent: ikinci çağrı aynı kapanışı bekler (pg-pool `end()` iki kez çağrılınca hata verir). */
  close(): Promise<void> {
    this.#closing ??= this.#internals.pool.end();
    return this.#closing;
  }
}

/** Paket içi. `packages/db` dışına export edilmez. */
export function dbInternals(db: OwlwireDb): DbInternals {
  return readInternals(db);
}

export function openDatabase(opts: OpenDatabaseOptions): OwlwireDb {
  // P0 createPool: connectionTimeoutMillis 5_000 (Görev 0 V5).
  const pool = createPool(opts.url, opts.maxConnections ?? 10);
  // pg-pool'da dinleyicisiz 'error' olayı süreci düşürür (P0 createDeps ile aynı koruma).
  const onError = opts.onPoolError ?? (() => undefined);
  // Boştaki istemci hatasını pg-pool kendi idle dinleyicisiyle havuz 'error' olayına çevirir; kullanımdaki
  // istemcide o dinleyici sökülür, bu yüzden istemci dinleyicimiz yalnız ödünç alınmış istemciler için
  // bildirir. Her hata onPoolError'a tam bir kez ulaşır.
  const checkedOut = new WeakSet<pg.PoolClient>();
  pool.on('error', (err) => onError(err));
  pool.on('acquire', (client) => checkedOut.add(client));
  pool.on('release', (_err, client) => checkedOut.delete(client));
  pool.on('connect', (client) =>
    client.on('error', (err) => {
      if (checkedOut.has(client)) onError(err);
    }),
  );
  return new OwlwireDb({
    drizzle: drizzle({ client: pool, schema }),
    pool,
    keyring: opts.keyring,
    clock: opts.clock,
  });
}
