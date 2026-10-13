import { AsyncLocalStorage } from 'node:async_hooks';
import { type SQL, sql } from 'drizzle-orm';
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

/** A TenantTx/SystemTx was used after its withTenant/withSystem callback ended. */
export class ScopeClosedError extends Error {
  constructor() {
    super(
      'scoped transaction is closed; do not keep a TenantTx or SystemTx after its callback ends',
    );
    this.name = 'ScopeClosedError';
  }
}

/** withTenant/withSystem was called inside another scope's callback; pass the open Tx instead. */
export class NestedScopeError extends Error {
  constructor() {
    super('withTenant/withSystem cannot be nested; pass the open TenantTx or SystemTx instead');
    this.name = 'NestedScopeError';
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

/** Module-private construction token: only withTenant/withSystem can build a Tx. */
const CONSTRUCT: unique symbol = Symbol('owlwire.scoped-tx');

interface TxAccess<X> {
  read(x: X): TxInternals;
  isOpen(x: X): boolean;
  close(x: X): void;
}

let tenantAccess: TxAccess<TenantTx>;
let systemAccess: TxAccess<SystemTx>;

function checkToken(token: unknown, what: string): void {
  if (token !== CONSTRUCT)
    throw new TypeError(
      `${what} is created only by ${what === 'TenantTx' ? 'withTenant' : 'withSystem'}`,
    );
}

export class TenantTx implements TenantScope {
  readonly workspaceId: string;
  readonly #internals: TxInternals;
  #open = true;

  constructor(token: typeof CONSTRUCT, workspaceId: string, internals: TxInternals) {
    checkToken(token, 'TenantTx');
    this.workspaceId = workspaceId;
    this.#internals = internals;
  }

  static {
    tenantAccess = {
      read: (t) => t.#internals,
      isOpen: (t) => t.#open,
      close: (t) => {
        t.#open = false;
      },
    };
  }
}

export class SystemTx implements SystemScope {
  readonly system = true as const;
  readonly #internals: TxInternals;
  #open = true;

  constructor(token: typeof CONSTRUCT, internals: TxInternals) {
    checkToken(token, 'SystemTx');
    this.#internals = internals;
  }

  static {
    systemAccess = {
      read: (s) => s.#internals,
      isOpen: (s) => s.#open,
      close: (s) => {
        s.#open = false;
      },
    };
  }
}

/**
 * Paket içi. Repository'ler bunu her sorguda çağırır; kapsamı biten (callback'i dönmüş) bir Tx
 * `ScopeClosedError` fırlatır, böylece sızan bir Tx başka bir kiracının transaction'ında çalışamaz.
 */
export function txInternals(t: TenantTx | SystemTx): TxInternals {
  if (t instanceof TenantTx) {
    if (!tenantAccess.isOpen(t)) throw new ScopeClosedError();
    return tenantAccess.read(t);
  }
  if (t instanceof SystemTx) {
    if (!systemAccess.isOpen(t)) throw new ScopeClosedError();
    return systemAccess.read(t);
  }
  throw new TypeError('expected a TenantTx or SystemTx');
}

/** Marks the async context of an open scope callback; `open` is cleared when the callback ends. */
const activeScope = new AsyncLocalStorage<{ open: boolean }>();

async function runScoped<X extends TenantTx | SystemTx, T>(
  db: OwlwireDb,
  gucs: SQL,
  build: (internals: TxInternals) => X,
  close: (x: X) => void,
  fn: (x: X) => Promise<T>,
): Promise<T> {
  // A nested scope would take a second pool connection (deadlock on a small pool) and not see
  // the outer transaction's writes.
  if (activeScope.getStore()?.open) throw new NestedScopeError();
  const internals = dbInternals(db);
  const marker = { open: true };
  return activeScope.run(marker, () =>
    internals.drizzle.transaction(async (tx) => {
      await tx.execute(gucs);
      const x = build({ tx, db: internals });
      try {
        return await fn(x);
      } finally {
        close(x);
        marker.open = false;
      }
    }),
  );
}

/** İç içe çağrılamaz (`NestedScopeError`); açık `TenantTx`'i iletin. */
export async function withTenant<T>(
  db: OwlwireDb,
  scope: TenantScope,
  fn: (t: TenantTx) => Promise<T>,
): Promise<T> {
  const { workspaceId } = tenantScope(scope.workspaceId);
  return runScoped(
    db,
    sql`select set_config('owlwire.workspace_id', ${workspaceId}, true), set_config('owlwire.system', '', true)`,
    (internals) => new TenantTx(CONSTRUCT, workspaceId, internals),
    tenantAccess.close,
    fn,
  );
}

/** İç içe çağrılamaz (`NestedScopeError`); açık `SystemTx`'i iletin. */
export async function withSystem<T>(
  db: OwlwireDb,
  scope: SystemScope,
  fn: (s: SystemTx) => Promise<T>,
): Promise<T> {
  if (scope.system !== true) throw new InvalidScopeError('system scope required');
  return runScoped(
    db,
    sql`select set_config('owlwire.system', 'on', true), set_config('owlwire.workspace_id', '', true)`,
    (internals) => new SystemTx(CONSTRUCT, internals),
    systemAccess.close,
    fn,
  );
}
