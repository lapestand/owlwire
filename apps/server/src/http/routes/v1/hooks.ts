import { EventInput, HookJsonInput } from '@owlwire/contracts';
import type { OwlwireDb } from '@owlwire/db';
import { Hono } from 'hono';
import { ingestEvent } from '../../../events/ingest.js';
import { idempotencyHeader, isJsonContentType, readJsonBody } from '../../body.js';
import { installationAuth } from '../../middleware/installation-auth.js';
import { ProblemError, validationProblem } from '../../problem.js';
import type { AppEnv } from '../../types.js';
import { assertTypeGranted } from './events.js';

export function hooksRoutes(deps: { db: OwlwireDb }): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.post('/hooks', installationAuth(deps.db, { allowQueryToken: true }), async (c) => {
    let title: string | undefined;
    let body: string;
    if (isJsonContentType(c)) {
      const parsed = HookJsonInput.safeParse(await readJsonBody(c));
      if (!parsed.success) throw validationProblem(parsed.error.issues);
      title = parsed.data.title;
      body = parsed.data.body;
    } else {
      body = await c.req.text();
    }
    body = body.trim();
    if (body.length === 0)
      throw new ProblemError(422, 'validation_failed', 'body must not be empty');
    const input = EventInput.safeParse({
      type: 'generic',
      severity: 'info',
      body,
      ...(title ? { title } : {}),
    });
    if (!input.success) throw validationProblem(input.error.issues);
    const installation = c.get('installation');
    assertTypeGranted(installation, 'generic');
    const result = await ingestEvent(deps.db, {
      installation,
      input: input.data,
      headerIdempotencyKey: idempotencyHeader(c),
    });
    c.get('log').info({ eventId: result.eventId, duplicate: result.duplicate }, 'hook accepted');
    return c.json(result, 202);
  });
  return r;
}
