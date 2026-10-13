import type {
  ConnectionKind,
  ConnectionRef,
  DestinationKind,
  DestinationRef,
  Platform,
  SendOutcome,
} from '@owlwire/adapter-sdk';
import { type Clock, computeBackoffMs, DEFAULT_MAX_ATTEMPTS } from '@owlwire/core';
import type { SecretBox } from '@owlwire/crypto';
import { connections, type Db, deliveries, destinations, events } from '@owlwire/db';
import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { AdapterRegistry } from '../../adapters/registry.js';
import { enqueueSendDelivery } from '../jobs.js';

export interface SendDeliveryDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  crypto: SecretBox;
  adapters: AdapterRegistry;
  rand: () => number;
  maxAttempts?: number;
}

export type SendDeliveryResult = 'delivered' | 'retry_scheduled' | 'failed' | 'skipped';

interface DeliveryCtx {
  deliveryId: string;
  connectionId: string;
  destinationId: string;
  platform: string;
  log: Logger;
}

const FINAL_STATUSES = new Set(['delivered', 'failed', 'suppressed', 'digested']);
/** status_reason values are machine keys (contract §10.7, R81); raw errors stay in last_error. */
const STATUS_KEY = /^[a-z]+\.status\.[A-Za-z]+$/;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fail(
  deps: SendDeliveryDeps,
  ctx: DeliveryCtx,
  error: string,
): Promise<SendDeliveryResult> {
  await deps.db
    .update(deliveries)
    .set({ status: 'failed', lastError: error, nextAttemptAt: null, updatedAt: deps.clock.now() })
    .where(eq(deliveries.id, ctx.deliveryId));
  ctx.log.warn({ error }, 'delivery failed');
  return 'failed';
}

async function applyOutcome(
  deps: SendDeliveryDeps,
  ctx: DeliveryCtx,
  attempts: number,
  outcome: SendOutcome,
): Promise<SendDeliveryResult> {
  const now = deps.clock.now();
  switch (outcome.status) {
    case 'ok': {
      await deps.db
        .update(deliveries)
        .set({
          status: 'delivered',
          platformMessageId: outcome.platformMessageId ?? null,
          deliveredAt: now,
          lastError: null,
          nextAttemptAt: null,
          updatedAt: now,
        })
        .where(eq(deliveries.id, ctx.deliveryId));
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
      const runAt = new Date(now.getTime() + delayMs);
      await deps.db.transaction(async (tx) => {
        await tx
          .update(deliveries)
          .set({ status: 'scheduled', nextAttemptAt: runAt, lastError: error, updatedAt: now })
          .where(eq(deliveries.id, ctx.deliveryId));
        await enqueueSendDelivery(tx, {
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
        await deps.db
          .update(destinations)
          .set({ status: 'broken', statusReason: 'send_failed' })
          .where(eq(destinations.id, ctx.destinationId));
      }
      return fail(deps, ctx, outcome.error);
    }
    case 'banned': {
      const reason = STATUS_KEY.test(outcome.error)
        ? outcome.error
        : `${ctx.platform}.status.banned`;
      await deps.db
        .update(connections)
        .set({ status: 'paused', statusReason: reason, updatedAt: now })
        .where(eq(connections.id, ctx.connectionId));
      return fail(deps, ctx, outcome.error);
    }
  }
}

export async function sendDelivery(
  deps: SendDeliveryDeps,
  payload: { deliveryId: string },
): Promise<SendDeliveryResult> {
  const [row] = await deps.db
    .select({
      delivery: deliveries,
      message: events.message,
      destination: destinations,
      connection: connections,
    })
    .from(deliveries)
    .innerJoin(events, eq(events.id, deliveries.eventId))
    .innerJoin(destinations, eq(destinations.id, deliveries.destinationId))
    .innerJoin(connections, eq(connections.id, deliveries.connectionId))
    .where(eq(deliveries.id, payload.deliveryId))
    .limit(1);
  if (!row) {
    deps.logger.warn({ deliveryId: payload.deliveryId }, 'send_delivery: delivery not found');
    return 'skipped';
  }
  const { delivery, destination, connection, message } = row;
  if (FINAL_STATUSES.has(delivery.status)) return 'skipped';

  const ctx: DeliveryCtx = {
    deliveryId: delivery.id,
    connectionId: connection.id,
    destinationId: destination.id,
    platform: connection.platform,
    log: deps.logger.child({
      deliveryId: delivery.id,
      eventId: delivery.eventId,
      workspaceId: delivery.workspaceId,
      connectionId: connection.id,
    }),
  };
  const attempts = delivery.attempts + 1;
  await deps.db
    .update(deliveries)
    .set({ status: 'sending', attempts, updatedAt: deps.clock.now() })
    .where(eq(deliveries.id, delivery.id));

  if (connection.status === 'paused' || connection.status === 'broken') {
    return fail(deps, ctx, `connection is ${connection.status}`);
  }
  const adapter = deps.adapters.get(connection.platform);
  if (!adapter) return fail(deps, ctx, `no adapter registered for platform ${connection.platform}`);

  let config: Record<string, unknown>;
  try {
    config = connection.configEnc
      ? deps.crypto.open<Record<string, unknown>>(connection.configEnc)
      : {};
  } catch (err) {
    return fail(deps, ctx, `connection config could not be decrypted: ${errorMessage(err)}`);
  }

  const conn: ConnectionRef = {
    id: connection.id,
    workspaceId: connection.workspaceId,
    platform: connection.platform as Platform,
    kind: connection.kind as ConnectionKind,
    config,
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
    const rendered = adapter.render(message, dest, adapter.capabilities(conn));
    outcome = await adapter.send(conn, dest, rendered, {});
  } catch (err) {
    outcome = { status: 'transient', error: errorMessage(err) };
  }
  return applyOutcome(deps, ctx, attempts, outcome);
}
