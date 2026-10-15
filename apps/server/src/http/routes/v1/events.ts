import { EventInput } from '@owlwire/contracts';
import type { OwlwireDb } from '@owlwire/db';
import { Hono } from 'hono';
import type { InstallationContext } from '../../../auth/installation-context.js';
import { ProblemError } from '../../../errors.js';
import { ingestEvent } from '../../../events/ingest.js';
import { idempotencyHeader, readJsonBody } from '../../body.js';
import { installationAuth } from '../../middleware/installation-auth.js';
import { validationProblem } from '../../problem.js';
import type { AppEnv } from '../../types.js';

export function assertTypeGranted(installation: InstallationContext, type: string): void {
  if (installation.grantedTypes && !installation.grantedTypes.includes(type)) {
    throw new ProblemError(
      422,
      'unknown_type',
      `type "${type}" is not granted to this installation`,
    );
  }
}

export function eventsRoutes(deps: { db: OwlwireDb }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/events', installationAuth(deps.db, { allowQueryToken: false }), async (c) => {
    const json = await readJsonBody(c);
    if (typeof json === 'object' && json !== null && 'events' in json) {
      throw new ProblemError(422, 'validation_failed', 'batch submission is not supported yet');
    }
    const parsed = EventInput.safeParse(json);
    if (!parsed.success) throw validationProblem(parsed.error.issues);
    const installation = c.get('installation');
    assertTypeGranted(installation, parsed.data.type);
    const result = await ingestEvent(deps.db, {
      installation,
      input: parsed.data,
      headerIdempotencyKey: idempotencyHeader(c),
    });
    c.get('log').info({ eventId: result.eventId, duplicate: result.duplicate }, 'event accepted');
    return c.json(result, 202);
  });
  return r;
}
