import type {
  ConnectionKind,
  ConnectionRef,
  DestinationKind,
  DestinationRef,
  Platform,
  SendOutcome,
} from '@owlwire/adapter-sdk';
import {
  type Clock,
  computeBackoffMs,
  DEFAULT_MAX_ATTEMPTS,
  type Message,
  scrubQueryParams,
  withholdEchoedInput,
} from '@owlwire/core';
import { DecryptError, UnknownKekVersionError } from '@owlwire/crypto';
import {
  type DeliveryContext,
  getDelivery,
  LegacySecretError,
  loadDeliveryContext,
  type OwlwireDb,
  safeErrorMessage,
  type TenantScope,
  updateConnectionStatus,
  updateDelivery,
  updateDestinationStatus,
  WorkspaceKeyMissingError,
  withTenant,
} from '@owlwire/db';
import type { Logger } from 'pino';
import type { AdapterRegistry } from '../../adapters/registry.js';
import { resolveJobTenant } from '../job-tenant.js';
import { enqueueSendDelivery } from '../jobs.js';

export interface SendDeliveryDeps {
  db: OwlwireDb;
  clock: Clock;
  logger: Logger;
  adapters: AdapterRegistry;
  rand: () => number;
  maxAttempts?: number;
}

export type SendDeliveryResult = 'delivered' | 'retry_scheduled' | 'failed' | 'skipped';

export interface SendDeliveryPayload {
  deliveryId: string;
  /** Stamped by enqueueJob (TenantTx); checked against the delivery's workspace. */
  _ws?: unknown;
}

interface DeliveryCtx {
  scope: TenantScope;
  deliveryId: string;
  connectionId: string;
  destinationId: string;
  platform: string;
  log: Logger;
}

const FINAL_STATUSES = new Set(['delivered', 'failed', 'suppressed', 'digested']);
/** status_reason values are machine keys (contract §10.7, R81); raw errors stay in last_error. */
const STATUS_KEY = /^[a-z]+\.status\.[A-Za-z]+$/;

/**
 * Deterministic config/key failures that a retry cannot fix; null for everything else. The returned text never carries
 * plaintext or query parameters: JSON.parse's SyntaxError echoes the decrypted text, so it gets a fixed message.
 */
function permanentConfigError(err: unknown): string | null {
  if (err instanceof SyntaxError) return 'SyntaxError: decrypted config is not valid JSON';
  if (
    err instanceof DecryptError ||
    err instanceof UnknownKekVersionError ||
    err instanceof WorkspaceKeyMissingError ||
    err instanceof LegacySecretError
  ) {
    return safeErrorMessage(err);
  }
  return null;
}

/** Written to deliveries.last_error and logged: without query parameters or echoed input (I-6). */
function errorMessage(err: unknown): string {
  return withholdEchoedInput(
    err,
    scrubQueryParams(err instanceof Error ? err.message : String(err)),
  );
}

async function fail(
  deps: SendDeliveryDeps,
  ctx: DeliveryCtx,
  error: string,
): Promise<SendDeliveryResult> {
  await withTenant(deps.db, ctx.scope, (t) =>
    updateDelivery(t, ctx.deliveryId, { status: 'failed', lastError: error, nextAttemptAt: null }),
  );
  ctx.log.warn({ error }, 'delivery failed');
  return 'failed';
}

async function applyOutcome(
  deps: SendDeliveryDeps,
  ctx: DeliveryCtx,
  attempts: number,
  outcome: SendOutcome,
): Promise<SendDeliveryResult> {
  switch (outcome.status) {
    case 'ok': {
      await withTenant(deps.db, ctx.scope, (t) =>
        updateDelivery(t, ctx.deliveryId, {
          status: 'delivered',
          platformMessageId: outcome.platformMessageId ?? null,
          deliveredAt: deps.clock.now(),
          lastError: null,
          nextAttemptAt: null,
        }),
      );
      ctx.log.info({ attempts }, 'delivery delivered');
      return 'delivered';
    }
    case 'transient':
    case 'rate_limited': {
      const error =
        outcome.status === 'transient'
          ? outcome.error
          : `rate limited, retry after ${outcome.retryAfterMs} ms`;
      const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (attempts >= maxAttempts) {
        return fail(deps, ctx, `giving up after ${attempts} attempts: ${error}`);
      }
      const delayMs =
        outcome.status === 'rate_limited'
          ? outcome.retryAfterMs
          : Math.max(computeBackoffMs(attempts, deps.rand), outcome.retryAfterMs ?? 0);
      const runAt = new Date(deps.clock.now().getTime() + delayMs);
      // Status and the re-scheduled job commit together (outbox).
      await withTenant(deps.db, ctx.scope, async (t) => {
        await updateDelivery(t, ctx.deliveryId, {
          status: 'scheduled',
          nextAttemptAt: runAt,
          lastError: error,
        });
        await enqueueSendDelivery(t, {
          deliveryId: ctx.deliveryId,
          connectionId: ctx.connectionId,
          runAt,
        });
      });
      ctx.log.warn({ attempts, delayMs, error }, 'delivery retry scheduled');
      return 'retry_scheduled';
    }
    case 'permanent': {
      if (outcome.destinationBroken) {
        await withTenant(deps.db, ctx.scope, (t) =>
          updateDestinationStatus(t, ctx.destinationId, 'broken', 'send_failed'),
        );
      }
      return fail(deps, ctx, outcome.error);
    }
    case 'banned': {
      const reason = STATUS_KEY.test(outcome.error)
        ? outcome.error
        : `${ctx.platform}.status.banned`;
      await withTenant(deps.db, ctx.scope, (t) =>
        updateConnectionStatus(t, ctx.connectionId, 'paused', reason),
      );
      return fail(deps, ctx, outcome.error);
    }
  }
}

/**
 * The platform call runs outside any transaction. Workspace comes from the delivery id (system lookup) and must match
 * the job's `_ws`; the connection config is decrypted inside the repository (workspace DEK).
 */
export async function sendDelivery(
  deps: SendDeliveryDeps,
  payload: SendDeliveryPayload,
): Promise<SendDeliveryResult> {
  const scope = await resolveJobTenant(deps.db, deps.logger, {
    task: 'send_delivery',
    kind: 'delivery',
    id: payload.deliveryId,
    payloadWorkspace: payload._ws,
  });
  if (!scope) return 'skipped';
  const delivery = await withTenant(deps.db, scope, async (t) => {
    const row = await getDelivery(t, payload.deliveryId);
    if (!row || FINAL_STATUSES.has(row.status)) return null;
    await updateDelivery(t, row.id, { status: 'sending', attempts: row.attempts + 1 });
    return row;
  });
  if (!delivery) return 'skipped';
  const attempts = delivery.attempts + 1;
  const log = deps.logger.child({
    deliveryId: delivery.id,
    eventId: delivery.eventId,
    workspaceId: scope.workspaceId,
    connectionId: delivery.connectionId,
  });
  const base = {
    scope,
    deliveryId: delivery.id,
    connectionId: delivery.connectionId,
    destinationId: delivery.destinationId,
    log,
  };

  let loaded: DeliveryContext | null;
  try {
    loaded = await withTenant(deps.db, scope, (t) => loadDeliveryContext(t, delivery.id));
  } catch (err) {
    const reason = permanentConfigError(err);
    // Anything else (lock or statement timeout, connection reset, serialization failure) is transient: rethrow so
    // Graphile retries the job. The row stays non-final ('sending'), so the retry processes it again.
    if (reason === null) throw err;
    return fail(
      deps,
      { ...base, platform: 'unknown' },
      `connection config could not be decrypted: ${reason}`,
    );
  }
  if (!loaded) return fail(deps, { ...base, platform: 'unknown' }, 'delivery context not found');
  const { connection, destination, event, config } = loaded;
  const ctx: DeliveryCtx = { ...base, platform: connection.platform };

  if (connection.status === 'paused' || connection.status === 'broken') {
    return fail(deps, ctx, `connection is ${connection.status}`);
  }
  const adapter = deps.adapters.get(connection.platform);
  if (!adapter) return fail(deps, ctx, `no adapter registered for platform ${connection.platform}`);

  const conn: ConnectionRef = {
    id: connection.id,
    workspaceId: connection.workspaceId,
    platform: connection.platform as Platform,
    kind: connection.kind as ConnectionKind,
    config: config ?? {},
  };
  const dest: DestinationRef = {
    id: destination.id,
    kind: destination.kind as DestinationKind,
    externalId: destination.externalId,
    externalSubId: destination.externalSubId,
    name: destination.name,
  };

  let outcome: SendOutcome;
  try {
    const rendered = adapter.render(event.message as Message, dest, adapter.capabilities(conn));
    outcome = await adapter.send(conn, dest, rendered, {});
  } catch (err) {
    outcome = { status: 'transient', error: errorMessage(err) };
  }
  return applyOutcome(deps, ctx, attempts, outcome);
}
