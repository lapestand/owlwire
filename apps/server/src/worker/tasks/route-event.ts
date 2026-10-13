import { type Clock, isSeverity, type Severity, severityRank } from '@owlwire/core';
import {
  createDeliveries,
  getDestinationsByIds,
  getEvent,
  listRulesForInstallation,
  markEventRouted,
  type OwlwireDb,
  withTenant,
} from '@owlwire/db';
import type { Logger } from 'pino';
import { resolveJobTenant } from '../job-tenant.js';

export interface RouteEventDeps {
  db: OwlwireDb;
  clock: Clock;
  logger: Logger;
}

export interface RouteEventPayload {
  eventId: string;
  /** Stamped by enqueueJob (TenantTx); checked against the event's workspace. */
  _ws?: unknown;
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

/**
 * P0 behaviour on the repositories: type + minimum severity, direct destination targets only, only active and
 * confirmed destinations. Audiences, consent and filters belong to the P1d router. Events of one installation run
 * in order on its route queue; UNIQUE(event_id, destination_id) prevents duplicate deliveries, and createDeliveries
 * enqueues send_delivery in the same transaction.
 */
export async function routeEvent(
  deps: RouteEventDeps,
  payload: RouteEventPayload,
): Promise<{ deliveryIds: string[] }> {
  const log = deps.logger.child({ eventId: payload.eventId });
  const scope = await resolveJobTenant(deps.db, log, {
    task: 'route_event',
    kind: 'event',
    id: payload.eventId,
    payloadWorkspace: payload._ws,
  });
  if (!scope) return { deliveryIds: [] };
  const deliveryIds = await withTenant(deps.db, scope, async (t) => {
    const ev = await getEvent(t, payload.eventId);
    if (!ev || ev.routedAt) return [];
    const severity: Severity = isSeverity(ev.severity) ? ev.severity : 'info';
    const rules = await listRulesForInstallation(t, ev.installationId);
    const destinationIds = [
      ...new Set(
        rules
          .filter((r) => ruleMatches(r, { type: ev.type, severity }))
          .flatMap((r) =>
            r.targets.flatMap((target) =>
              'destinationId' in target ? [target.destinationId] : [],
            ),
          ),
      ),
    ];
    const now = deps.clock.now();
    const targets = (await getDestinationsByIds(t, destinationIds)).filter(
      (d) => d.status === 'active' && d.consentStatus === 'confirmed',
    );
    const created = await createDeliveries(
      t,
      ev.id,
      targets.map((d) => ({ destinationId: d.id, connectionId: d.connectionId, runAt: now })),
    );
    await markEventRouted(t, ev.id);
    return created.map((d) => d.id);
  });
  log.info({ workspaceId: scope.workspaceId, deliveries: deliveryIds.length }, 'event routed');
  return { deliveryIds };
}
