import { sql } from 'drizzle-orm';
import { type DbInternals, type DrizzleTx, dbInternals, type OwlwireDb } from './handle.js';

export interface TenantScope {
  readonly workspaceId: string;
}

export interface SystemScope {
  readonly system: true;
}

export const SYSTEM: SystemScope = Object.freeze({ system: true as const });

export class InvalidScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidScopeError';
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function tenantScope(workspaceId: string): TenantScope {
  if (typeof workspaceId !== 'string' || !UUID_RE.test(workspaceId)) {
    throw new InvalidScopeError('workspaceId must be a UUID');
  }
  return Object.freeze({ workspaceId: workspaceId.toLowerCase() });
}

interface TxInternals {
  readonly tx: DrizzleTx;
  readonly db: DbInternals;
}

let readTenant: (t: TenantTx) => TxInternals;
let readSystem: (s: SystemTx) => TxInternals;

export class TenantTx implements TenantScope {
  readonly workspaceId: string;
  readonly #internals: TxInternals;

  constructor(workspaceId: string, internals: TxInternals) {
    this.workspaceId = workspaceId;
    this.#internals = internals;
  }

  static {
    readTenant = (t) => t.#internals;
  }
}

export class SystemTx implements SystemScope {
  readonly system = true as const;
  readonly #internals: TxInternals;

  constructor(internals: TxInternals) {
    this.#internals = internals;
  }

  static {
    readSystem = (s) => s.#internals;
  }
}

/** Paket içi. */
export function txInternals(t: TenantTx | SystemTx): TxInternals {
  return t instanceof TenantTx ? readTenant(t) : readSystem(t);
}

export async function withTenant<T>(
  db: OwlwireDb,
  scope: TenantScope,
  fn: (t: TenantTx) => Promise<T>,
): Promise<T> {
  const { workspaceId } = tenantScope(scope.workspaceId);
  const internals = dbInternals(db);
  return internals.drizzle.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('owlwire.workspace_id', ${workspaceId}, true), set_config('owlwire.system', '', true)`,
    );
    return fn(new TenantTx(workspaceId, { tx, db: internals }));
  });
}

export async function withSystem<T>(
  db: OwlwireDb,
  scope: SystemScope,
  fn: (s: SystemTx) => Promise<T>,
): Promise<T> {
  if (scope.system !== true) throw new InvalidScopeError('system scope required');
  const internals = dbInternals(db);
  return internals.drizzle.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('owlwire.system', 'on', true), set_config('owlwire.workspace_id', '', true)`,
    );
    return fn(new SystemTx({ tx, db: internals }));
  });
}
