import type { EventInput } from '@owlwire/contracts';
import { type Message, newId } from '@owlwire/core';
import { type Db, events } from '@owlwire/db';
import { and, eq } from 'drizzle-orm';
import type { InstallationContext } from '../http/types.js';
import { enqueueRouteEvent } from '../worker/jobs.js';

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
}

export function toMessage(input: EventInput): Message {
  const { idempotencyKey: _ignored, severity, ...rest } = input;
  return { ...rest, severity: severity ?? 'info' };
}

/** Stores the event and enqueues route_event atomically (outbox); repeats return the stored event. */
export async function ingestEvent(
  db: Db,
  args: {
    installation: InstallationContext;
    input: EventInput;
    headerIdempotencyKey: string | undefined;
  },
): Promise<IngestResult> {
  const idempotencyKey = args.input.idempotencyKey ?? args.headerIdempotencyKey ?? newId();
  const message = toMessage(args.input);
  return db.transaction(async (tx) => {
    const id = newId();
    const inserted = await tx
      .insert(events)
      .values({
        id,
        workspaceId: args.installation.workspaceId,
        installationId: args.installation.id,
        idempotencyKey,
        type: message.type,
        severity: message.severity,
        message,
      })
      .onConflictDoNothing({ target: [events.installationId, events.idempotencyKey] })
      .returning({ id: events.id });
    if (inserted.length > 0) {
      await enqueueRouteEvent(tx, id);
      return { eventId: id, duplicate: false };
    }
    const [existing] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.installationId, args.installation.id),
          eq(events.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) throw new Error('idempotency conflict without a stored event');
    return { eventId: existing.id, duplicate: true };
  });
}
