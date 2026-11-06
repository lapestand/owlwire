import type { OpenAPIHono } from '@hono/zod-openapi';
import { putCatalogRoute } from '@owlwire/contracts/routes';
import { type AuditActor, SYSTEM_ACTOR, tenantScope } from '@owlwire/db';
import type { Deps } from '../../../deps.js';
import { putCatalog } from '../../../services/apps.js';
import { serviceDeps } from '../../../services/types.js';
import { ingestKeys } from '../../../system/rate-limit.js';
import { catalogAuth } from '../../middleware/installation-auth.js';
import { ingestRateLimit } from '../../middleware/rate-limit.js';
import type { AppEnv } from '../../types.js';
import { toCatalogTypeView } from '../../views.js';

export function registerCatalogRoutes(app: OpenAPIHono<AppEnv>, deps: Deps): void {
  const auth = catalogAuth(deps);
  const limit = ingestRateLimit(deps, (c) => ingestKeys.app(c.get('catalogPrincipal').appId));
  // The wildcard also matches /v1/catalog itself; one registration keeps auth and the limit to one run per request.
  app.use('/v1/catalog/*', auth, limit);
  app.openapi(putCatalogRoute, async (c) => {
    const principal = c.get('catalogPrincipal');
    const { types } = c.req.valid('json');
    // A private app's own installation token is audited as that installation. An app key has no user or
    // installation behind it: it is audited as the system actor, with data.via = 'app_key' telling it apart.
    const installationId = principal.via === 'installation' ? principal.installationId : null;
    const actor: AuditActor =
      installationId !== null ? { kind: 'installation', installationId } : SYSTEM_ACTOR;
    const rows = await putCatalog(
      serviceDeps(deps),
      tenantScope(principal.ownerWorkspaceId),
      actor,
      principal.appId,
      types,
      installationId !== null ? {} : { via: 'app_key' },
    );
    c.get('log').info({ appId: principal.appId, types: types.length }, 'catalog updated');
    return c.json({ types: rows.map(toCatalogTypeView) }, 200);
  });
}
