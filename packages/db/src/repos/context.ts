import type { Keyring } from '@owlwire/crypto';
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
