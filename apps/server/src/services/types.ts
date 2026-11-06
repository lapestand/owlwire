import type { Clock, EditionConfig } from '@owlwire/core';
import type { AuditActor, OwlwireDb } from '@owlwire/db';
import type { Deps } from '../deps.js';
import type { PayloadSchemaRegistry } from './payload-schema.js';

export interface ServiceDeps {
  db: OwlwireDb;
  clock: Clock;
  /** Effective edition config (deps.config.edition until stored settings can override it). */
  config: EditionConfig;
  payloadSchemas: PayloadSchemaRegistry;
}

export function serviceDeps(
  deps: Pick<Deps, 'db' | 'clock' | 'config' | 'payloadSchemas'>,
): ServiceDeps {
  return {
    db: deps.db,
    clock: deps.clock,
    config: deps.config.edition,
    payloadSchemas: deps.payloadSchemas,
  };
}

export function userIdOf(actor: AuditActor): string | null {
  return actor.kind === 'user' ? actor.userId : null;
}
