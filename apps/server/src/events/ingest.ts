import type { EventInput } from '@owlwire/contracts';
import { type Message, newId } from '@owlwire/core';
import { insertEvent, type OwlwireDb, tenantScope, withTenant } from '@owlwire/db';
import type { InstallationContext } from '../http/types.js';

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
}

export function toMessage(input: EventInput): Message {
  const { idempotencyKey: _ignored, severity, ...rest } = input;
  return { ...rest, severity: severity ?? 'info' };
}

/** Blank keys count as absent: a shared empty key would turn every later event into a duplicate. */
export function resolveIdempotencyKey(
  bodyKey: string | undefined,
  headerKey: string | undefined,
): string {
  const body = bodyKey?.trim();
  if (body) return body;
  const header = headerKey?.trim();
  if (header) return header;
  return newId();
}

/** Stores the event and enqueues route_event atomically (outbox); repeats return the stored event. */
export async function ingestEvent(
  db: OwlwireDb,
  args: {
    installation: InstallationContext;
    input: EventInput;
    headerIdempotencyKey: string | undefined;
  },
): Promise<IngestResult> {
  const idempotencyKey = resolveIdempotencyKey(
    args.input.idempotencyKey,
    args.headerIdempotencyKey,
  );
  const message = toMessage(args.input);
  // insertEvent enqueues route_event in the same transaction (outbox) on the installation's route queue.
  const { eventId, duplicate } = await withTenant(
    db,
    tenantScope(args.installation.workspaceId),
    (t) =>
      insertEvent(t, {
        installationId: args.installation.id,
        idempotencyKey,
        type: message.type,
        severity: message.severity,
        message,
      }),
  );
  return { eventId, duplicate };
}
