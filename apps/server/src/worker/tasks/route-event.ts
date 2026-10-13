import { type Clock, isSeverity, newId, type Severity, severityRank } from '@owlwire/core';
import { type Db, deliveries, destinations, events, rules, ruleTargets } from '@owlwire/db';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { enqueueSendDelivery } from '../jobs.js';

export interface RouteEventDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
}

export function ruleMatches(
  rule: { types: string[]; minSeverity: string; enabled: boolean },
  ev: { type: string; severity: Severity },
): boolean {
  if (!rule.enabled) return false;
  const typeMatches = rule.types.includes('*') || rule.types.includes(ev.type);
  const min: Severity = isSeverity(rule.minSeverity) ? rule.minSeverity : 'info';
  return typeMatches && severityRank(ev.severity) >= severityRank(min);
}

export async function routeEvent(
  deps: RouteEventDeps,
  payload: { eventId: string },
): Promise<{ deliveryIds: string[] }> {
  const log = deps.logger.child({ eventId: payload.eventId });
  const deliveryIds = await deps.db.transaction(async (tx) => {
    const [ev] = await tx
      .select()
      .from(events)
      .where(eq(events.id, payload.eventId))
      .limit(1)
      .for('update');
    if (!ev) {
      log.warn('route_event: event not found');
      return [];
    }
    if (ev.routedAt) return [];

    const candidates = await tx
      .select({
        types: rules.types,
        minSeverity: rules.minSeverity,
        enabled: rules.enabled,
        destinationId: ruleTargets.destinationId,
      })
      .from(rules)
      .innerJoin(ruleTargets, eq(ruleTargets.ruleId, rules.id))
      .where(
        and(
          eq(rules.installationId, ev.installationId),
          eq(rules.workspaceId, ev.workspaceId),
          eq(ruleTargets.workspaceId, ev.workspaceId),
          isNotNull(ruleTargets.destinationId),
        ),
      );
    const severity: Severity = isSeverity(ev.severity) ? ev.severity : 'info';
    const destinationIds = [
      ...new Set(
        candidates
          .filter((r) => ruleMatches(r, { type: ev.type, severity }))
          .flatMap((r) => (r.destinationId ? [r.destinationId] : [])),
      ),
    ];

    const now = deps.clock.now();
    const created: string[] = [];
    if (destinationIds.length > 0) {
      const targets = await tx
        .select({ id: destinations.id, connectionId: destinations.connectionId })
        .from(destinations)
        .where(
          and(
            inArray(destinations.id, destinationIds),
            eq(destinations.workspaceId, ev.workspaceId),
            eq(destinations.status, 'active'),
            eq(destinations.consentStatus, 'confirmed'),
          ),
        );
      for (const target of targets) {
        const id = newId();
        const inserted = await tx
          .insert(deliveries)
          .values({
            id,
            workspaceId: ev.workspaceId,
            eventId: ev.id,
            destinationId: target.id,
            connectionId: target.connectionId,
            status: 'pending',
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing({ target: [deliveries.eventId, deliveries.destinationId] })
          .returning({ id: deliveries.id });
        if (inserted.length > 0) {
          await enqueueSendDelivery(tx, {
            deliveryId: id,
            connectionId: target.connectionId,
            runAt: now,
          });
          created.push(id);
        }
      }
    }
    await tx.update(events).set({ routedAt: now }).where(eq(events.id, ev.id));
    return created;
  });
  log.info({ deliveries: deliveryIds.length }, 'event routed');
  return { deliveryIds };
}
