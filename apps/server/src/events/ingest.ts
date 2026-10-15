import type { EventInput } from '@owlwire/contracts';
import { type Message, newId } from '@owlwire/core';
import {
  insertEvent,
  type OwlwireDb,
  RepoNotFoundError,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import type { InstallationContext } from '../auth/installation-context.js';
import { BEARER_CHALLENGE, ProblemError } from '../errors.js';

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
}

function toMessage(input: EventInput): Message {
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
  // insertEvent enqueues route_event in the same transaction (outbox) on the installation's route queue. It re-checks
  // `status = 'active'` inside the tenant transaction: an installation revoked after the auth middleware ran is
  // refused there (RepoNotFoundError('installation')) and answered like the middleware would.
  let result: IngestResult;
  try {
    result = await withTenant(db, tenantScope(args.installation.workspaceId), (t) =>
      insertEvent(t, {
        installationId: args.installation.id,
        idempotencyKey,
        type: message.type,
        severity: message.severity,
        message,
      }),
    );
  } catch (err) {
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
  const { eventId, duplicate } = result;
  return { eventId, duplicate };
}
