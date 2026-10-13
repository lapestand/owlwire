import { isUuid } from '@owlwire/core';
import type { Keyring } from '@owlwire/crypto';
import { RepoNotFoundError } from '../errors.js';
import type { DrizzleTx } from '../handle.js';
import { type SystemTx, type TenantTx, txInternals } from '../scope.js';

/** Paket içi: repository'lerin transaction'a erişimi. */
export function q(t: TenantTx | SystemTx): DrizzleTx {
  return txInternals(t).tx;
}

export function now(t: TenantTx | SystemTx): Date {
  return txInternals(t).db.clock.now();
}

export function keyringOf(t: TenantTx | SystemTx): Keyring {
  return txInternals(t).db.keyring;
}

/** Stands in for a malformed id in RepoNotFoundError: the caller's raw input is never echoed. */
export const MALFORMED_ID = '(malformed id)';

/**
 * Malformed ids are answered like unknown ids, before any SQL (a `uuid` column would raise pg 22P02 and echo the
 * value): mutators and lookups that already throw for unknown ids call this, getters and lists return null or empty.
 */
export function assertIdShape(entity: string, id: unknown): asserts id is string {
  if (!isUuid(id)) throw new RepoNotFoundError(entity, MALFORMED_ID);
}
