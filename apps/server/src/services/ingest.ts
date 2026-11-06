import type { BatchItemErrorCode, EventInput } from '@owlwire/contracts';
import { newId } from '@owlwire/core';
import type { Message } from '@owlwire/core/message';
import {
  type CatalogTypeRow,
  type InsertEventInput,
  type InsertedEvent,
  insertEvents,
  listCatalog,
  pgErrorCode,
  RepoNotFoundError,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import { BEARER_CHALLENGE, ProblemError, unavailable } from '../errors.js';
import {
  isValidatorUnavailable,
  type PayloadSchemaRegistry,
  VALIDATOR_BUSY_DETAIL,
} from './payload-schema.js';
import type { ServiceDeps } from './types.js';

/** The installation an event arrives for (the installation-token principal has this shape). */
export interface IngestPrincipal {
  installationId: string;
  workspaceId: string;
  appId: string;
  grantedTypes: string[] | null;
}

type PrepareResult =
  | { ok: true; row: InsertEventInput }
  | { ok: false; code: BatchItemErrorCode; detail: string };

export type IngestResult = InsertedEvent | { error: { code: BatchItemErrorCode; detail: string } };

export function resolveIdempotencyKey(
  bodyKey: string | undefined,
  headerKey: string | undefined,
  gen: () => string,
): { ok: true; key: string } | { ok: false; detail: string } {
  // Blank keys count as absent: a shared empty key would turn every later event into a duplicate.
  const body = bodyKey?.trim() || undefined;
  const header = headerKey?.trim() || undefined;
  if (body !== undefined && header !== undefined && body !== header) {
    return {
      ok: false,
      detail: 'idempotencyKey in the body and the Idempotency-Key header differ',
    };
  }
  return { ok: true, key: body ?? header ?? gen() };
}

/**
 * Checks one event against the app catalog and turns it into a row to store. The first failing check wins:
 * the type is in the catalog (unknown_type), granted to the installation (forbidden), `data` matches the
 * type's payload schema (validation_failed), the body and header idempotency keys agree (validation_failed).
 * A validator that cannot take the call (busy, closed, stopped) says nothing about the event: it throws a
 * retryable 503 for the whole request instead of failing the event.
 */
export async function prepareEvent(
  input: EventInput,
  p: IngestPrincipal,
  catalog: ReadonlyMap<string, CatalogTypeRow>,
  schemas: PayloadSchemaRegistry,
  headerKey: string | undefined,
  gen: () => string = newId,
): Promise<PrepareResult> {
  const type = catalog.get(input.type);
  if (!type) {
    return {
      ok: false,
      code: 'unknown_type',
      detail: `type "${input.type}" is not in the app catalog`,
    };
  }
  if (p.grantedTypes !== null && !p.grantedTypes.includes(input.type)) {
    return {
      ok: false,
      code: 'forbidden',
      detail: `type "${input.type}" is not granted to this installation`,
    };
  }
  if (type.payloadSchema) {
    // The cache key changes whenever the type is updated, so a stale compiled validator is never reused.
    const check = await schemas.validate(
      `${type.appId}:${type.key}:${type.updatedAt.toISOString()}`,
      type.payloadSchema,
      input.data ?? {},
    );
    if (isValidatorUnavailable(check)) {
      throw unavailable(VALIDATOR_BUSY_DETAIL);
    }
    if (!check.ok) return { ok: false, code: 'validation_failed', detail: check.detail };
  }
  const idem = resolveIdempotencyKey(input.idempotencyKey, headerKey, gen);
  if (!idem.ok) return { ok: false, code: 'validation_failed', detail: idem.detail };

  const { idempotencyKey: _omit, ...rest } = input;
  const severity = input.severity ?? type.defaultSeverity ?? 'info';
  const message: Message = { ...rest, severity };
  return {
    ok: true,
    row: {
      installationId: p.installationId,
      idempotencyKey: idem.key,
      type: input.type,
      severity,
      message,
    },
  };
}

/**
 * Attempts for the write transaction when Postgres aborts it as a deadlock victim. Sorting by key removes the
 * deadlock between overlapping batches, but graphile_worker.add_job also creates the route queue row on the
 * first job of an installation, and that unique entry is locked until commit as well: two concurrent first
 * batches with partly overlapping keys can still wait on each other there. Postgres aborts one of them; the
 * transaction is rolled back whole (events and jobs), so running it again is safe and finds the queue in place.
 */
const DEADLOCK_ATTEMPTS = 3;
const DEADLOCK_DETECTED = '40P01';
const DEADLOCK_DETAIL = 'The server is busy storing events; try again.';

/**
 * Prepares and stores a batch in three steps, so that no database connection is held while payloads are
 * validated (a validator call can wait for a worker and take up to its deadlines):
 * 1. a short tenant transaction reads the app catalog;
 * 2. every event is checked against that snapshot with no connection held (a catalog change after the read
 *    is not seen by this batch);
 * 3. one write transaction stores the valid events with their route_event jobs, retried on a deadlock.
 * Results follow the order of `inputs`; an invalid event gets an error item and is not stored.
 * `deadlockAttempts` exists for tests.
 */
export async function ingestEvents(
  d: ServiceDeps,
  p: IngestPrincipal,
  inputs: EventInput[],
  headerKey: string | undefined,
  opts: { deadlockAttempts?: number } = {},
): Promise<IngestResult[]> {
  const scope = tenantScope(p.workspaceId);
  const types = await withTenant(d.db, scope, (t) => listCatalog(t, p.appId));
  const catalog = new Map(types.map((type) => [type.key, type]));

  // One event at a time: a large batch must not take every validator worker from other requests.
  const prepared: PrepareResult[] = [];
  for (const input of inputs) {
    prepared.push(await prepareEvent(input, p, catalog, d.payloadSchemas, headerKey));
  }

  // Each insert holds a lock on its (installation_id, idempotency_key) index entry until commit. Two
  // concurrent batches that share keys in different orders would wait on each other and deadlock (40P01),
  // so every batch inserts in idempotency-key order. The sort is stable: of two events with the same key in
  // one batch the earlier one is stored and the later one is reported as its duplicate.
  const valid = prepared.flatMap((r, index) => (r.ok ? [{ index, row: r.row }] : []));
  valid.sort((a, b) => compareKeys(a.row.idempotencyKey, b.row.idempotencyKey));
  const inserted =
    valid.length > 0
      ? await storeRows(
          d,
          p,
          valid.map((v) => v.row),
          opts.deadlockAttempts ?? DEADLOCK_ATTEMPTS,
        )
      : [];
  if (inserted.length !== valid.length) {
    throw new Error('ingestEvents: insert result count mismatch');
  }
  const byIndex = new Map(valid.map((v, i) => [v.index, inserted[i]]));
  return prepared.map((r, index): IngestResult => {
    if (!r.ok) return { error: { code: r.code, detail: r.detail } };
    const result = byIndex.get(index);
    if (!result) throw new Error('ingestEvents: missing insert result');
    return result;
  });
}

async function storeRows(
  d: ServiceDeps,
  p: IngestPrincipal,
  rows: InsertEventInput[],
  attempts: number,
): Promise<InsertedEvent[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTenant(d.db, tenantScope(p.workspaceId), (t) => insertEvents(t, rows));
    } catch (err) {
      if (pgErrorCode(err) === DEADLOCK_DETECTED) {
        if (attempt < attempts) continue;
        throw unavailable(DEADLOCK_DETAIL);
      }
      // insertEvent re-checks status = 'active' in the write transaction, so an installation revoked after
      // the auth middleware ran is answered the way the middleware would (and nothing is stored).
      if (err instanceof RepoNotFoundError && err.entity === 'installation') {
        throw new ProblemError(
          401,
          'installation_revoked',
          'installation has been revoked',
          BEARER_CHALLENGE,
        );
      }
      throw err;
    }
  }
}

/** Code-unit order: the same total order in every process, unlike a locale-aware comparison. */
function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
