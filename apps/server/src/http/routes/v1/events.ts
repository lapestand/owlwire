import type { OpenAPIHono } from '@hono/zod-openapi';
import { PROBLEM_STATUS } from '@owlwire/contracts';
import { getEventRoute, postEventsRoute } from '@owlwire/contracts/routes';
import { getEventStatus, tenantScope, withTenant } from '@owlwire/db';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { Deps } from '../../../deps.js';
import { notFound, ProblemError } from '../../../errors.js';
import { ingestEvents } from '../../../services/ingest.js';
import { serviceDeps } from '../../../services/types.js';
import { consumeIngestBatchRemainder, ingestKeys } from '../../../system/rate-limit.js';
import { installationAuth } from '../../middleware/installation-auth.js';
import { ingestRateLimit } from '../../middleware/rate-limit.js';
import type { AppEnv } from '../../types.js';

/** Blank keys count as absent, the same way the ingest service reads them. */
function presentKey(key: string | undefined): string | undefined {
  return key?.trim() || undefined;
}

export function registerEventRoutes(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const auth = installationAuth(deps.db, { allowQueryToken: false });
  const limit = ingestRateLimit(deps, (c) =>
    ingestKeys.installation(c.get('installation').installationId),
  );
  // The wildcard also matches /v1/events itself, so one registration covers POST and GET without running twice.
  app.use('/v1/events/*', auth, limit);

  app.openapi(postEventsRoute, async (c) => {
    const body = c.req.valid('json');
    const headerKey = presentKey(c.req.valid('header')['idempotency-key']);
    const principal = c.get('installation');

    if ('events' in body) {
      // Each event of a batch carries its own key: one header key would collapse the batch into one event.
      if (headerKey !== undefined) {
        throw new ProblemError(
          400,
          'validation_failed',
          'the Idempotency-Key header is not allowed for batches; set idempotencyKey on each event',
        );
      }
      await consumeIngestBatchRemainder(
        deps,
        ingestKeys.installation(principal.installationId),
        body.events.length,
      );
      const results = await ingestEvents(serviceDeps(deps), principal, body.events, undefined);
      c.get('log').info(
        {
          accepted: results.filter((r) => !('error' in r)).length,
          rejected: results.filter((r) => 'error' in r).length,
        },
        'event batch accepted',
      );
      return c.json({ results }, 202);
    }

    const bodyKey = presentKey(body.idempotencyKey);
    if (headerKey !== undefined && bodyKey !== undefined && bodyKey !== headerKey) {
      throw new ProblemError(
        400,
        'validation_failed',
        'idempotencyKey in the body and the Idempotency-Key header differ',
      );
    }
    const [result] = await ingestEvents(serviceDeps(deps), principal, [body], headerKey);
    if (!result) throw new Error('ingestEvents returned no result for a single event');
    if ('error' in result) {
      throw new ProblemError(
        PROBLEM_STATUS[result.error.code] as ContentfulStatusCode,
        result.error.code,
        result.error.detail,
      );
    }
    c.get('log').info({ eventId: result.eventId, duplicate: result.duplicate }, 'event accepted');
    return c.json(result, 202);
  });

  app.openapi(getEventRoute, async (c) => {
    const { id } = c.req.valid('param');
    const principal = c.get('installation');
    const status = await withTenant(deps.db, tenantScope(principal.workspaceId), (t) =>
      getEventStatus(t, principal.installationId, id),
    );
    if (!status) throw notFound();
    return c.json(status, 200);
  });
}
