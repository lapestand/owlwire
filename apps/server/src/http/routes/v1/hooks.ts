import type { OpenAPIHono } from '@hono/zod-openapi';
import { EventInput, HookJsonInput, PROBLEM_STATUS } from '@owlwire/contracts';
import { postHooksRoute } from '@owlwire/contracts/routes';
import { GENERIC_TYPE_KEY } from '@owlwire/core';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Deps } from '../../../deps.js';
import { ProblemError } from '../../../errors.js';
import { ingestEvents } from '../../../services/ingest.js';
import { serviceDeps } from '../../../services/types.js';
import { ingestKeys } from '../../../system/rate-limit.js';
import { idempotencyHeader, isJsonContentType, readJsonBody } from '../../body.js';
import { installationAuth } from '../../middleware/installation-auth.js';
import { ingestRateLimit } from '../../middleware/rate-limit.js';
import { validationProblem } from '../../problem.js';
import type { AppEnv } from '../../types.js';

/**
 * A JSON body is `{ title?, body }`; every other content type (text/plain, curl -d form bodies, none at all) is
 * the raw message body. The body is trimmed and then checked like any event body (not empty, at most 8000 chars).
 */
async function readHookInput(c: Context<AppEnv>): Promise<EventInput> {
  let candidate: Record<string, unknown>;
  if (isJsonContentType(c)) {
    const parsed = HookJsonInput.safeParse(await readJsonBody(c));
    if (!parsed.success) throw validationProblem(parsed.error.issues);
    candidate = { type: GENERIC_TYPE_KEY, body: parsed.data.body.trim() };
    if (parsed.data.title !== undefined) candidate.title = parsed.data.title;
  } else {
    candidate = { type: GENERIC_TYPE_KEY, body: (await c.req.text()).trim() };
  }
  const event = EventInput.safeParse(candidate);
  if (!event.success) throw validationProblem(event.error.issues);
  return event.data;
}

export function registerHookRoutes(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const auth = installationAuth(deps.db, { allowQueryToken: true });
  const limit = ingestRateLimit(deps, (c) =>
    ingestKeys.installation(c.get('installation').installationId),
  );
  // The wildcard also matches /v1/hooks itself; one registration keeps auth and the limit to one run per request.
  app.use('/v1/hooks/*', auth, limit);
  // Documented from the contract but handled by hand, so that any content type is read as text.
  app.openAPIRegistry.registerPath(postHooksRoute);
  app.post('/v1/hooks', async (c) => {
    const input = await readHookInput(c);
    const principal = c.get('installation');
    const [result] = await ingestEvents(
      serviceDeps(deps),
      principal,
      [input],
      idempotencyHeader(c),
    );
    if (!result) throw new Error('ingestEvents returned no result for a single event');
    if ('error' in result) {
      throw new ProblemError(
        PROBLEM_STATUS[result.error.code] as ContentfulStatusCode,
        result.error.code,
        result.error.detail,
      );
    }
    c.get('log').info({ eventId: result.eventId, duplicate: result.duplicate }, 'hook accepted');
    return c.json(result, 202);
  });
}
