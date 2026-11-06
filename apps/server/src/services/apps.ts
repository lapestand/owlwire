import { type AppCreateInput, CatalogPutInput, type CatalogTypeInput } from '@owlwire/contracts';
import { generateSlug, newId } from '@owlwire/core';
import { issueToken } from '@owlwire/crypto';
import {
  type AppRow,
  type AuditActor,
  type CatalogTypeRow,
  createApp,
  createInstallation,
  getApp,
  type InstallationRow,
  listCatalog,
  setAppKey,
  type TenantScope,
  upsertCatalogTypes,
  withTenant,
} from '@owlwire/db';
import { notFound, ProblemError, unavailable } from '../errors.js';
import { approveNewPublicApp } from '../system/initial-approval.js';
import { isValidatorUnavailable, VALIDATOR_BUSY_DETAIL } from './payload-schema.js';
import { type ServiceDeps, userIdOf } from './types.js';

/** How long the previous app key keeps working after a rotation. */
const APP_KEY_GRACE_MS = 24 * 60 * 60 * 1000;

const MAX_DETAIL_LENGTH = 1000;

const slugSuffix = (): string => newId().replace(/-/g, '').slice(-6);

export interface CreatedApp {
  app: AppRow;
  /** The first app key of a public app, returned only here. */
  appKey: string | null;
  /** The automatic installation of a private app into its own workspace. */
  installation: InstallationRow | null;
  /** Token of that installation, returned only here. */
  token: string | null;
}

/**
 * A private app is approved, gets no app key (a rotation can add one later) and is installed into its own
 * workspace at once. A public app is always created pending in the tenant transaction; when an instance admin
 * created it or the edition does not require approval, a second, system-mode transaction approves it after the
 * first one committed (the two cannot nest). If that step fails the app stays pending and the error reaches the
 * caller.
 */
export async function createWorkspaceApp(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  input: AppCreateInput,
  opts: { isInstanceAdmin: boolean },
): Promise<CreatedApp> {
  const base = {
    name: input.name,
    slug: generateSlug(input.name, slugSuffix()),
    visibility: input.visibility,
    description: input.description ?? null,
    homepageUrl: input.homepageUrl ?? null,
  } as const;
  const created = await withTenant(d.db, scope, async (t): Promise<CreatedApp> => {
    if (input.visibility === 'private') {
      const app = await createApp(t, base, actor);
      const issued = issueToken('inst');
      const installation = await createInstallation(
        t,
        {
          appId: app.id,
          tokenHash: issued.hash,
          tokenPrefix: issued.prefix,
          createdByUserId: userIdOf(actor),
        },
        actor,
      );
      return { app, appKey: null, installation, token: issued.token };
    }
    const key = issueToken('app');
    const app = await createApp(
      t,
      { ...base, appKey: { hash: key.hash, prefix: key.prefix } },
      actor,
    );
    return { app, appKey: key.token, installation: null, token: null };
  });
  if (
    input.visibility === 'public' &&
    (opts.isInstanceAdmin || !d.config.publicApps.requireApproval)
  ) {
    const reason = opts.isInstanceAdmin ? 'instance_admin' : 'approval_not_required';
    return { ...created, app: await approveNewPublicApp(d.db, created.app.id, actor, reason) };
  }
  return created;
}

/** New current key for an own app; the old one keeps working for APP_KEY_GRACE_MS. */
export async function rotateAppKey(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  appId: string,
): Promise<{ appKey: string; appKeyPrefix: string; previousKeyExpiresAt: Date | null }> {
  const key = issueToken('app');
  const expiresAt = new Date(d.clock.now().getTime() + APP_KEY_GRACE_MS);
  const r = await withTenant(d.db, scope, (t) => setAppKey(t, appId, key, expiresAt, actor));
  if (!r) throw notFound();
  return {
    appKey: key.token,
    appKeyPrefix: key.prefix,
    previousKeyExpiresAt: r.previousKeyExpiresAt,
  };
}

/**
 * Checks the whole list the way the API body is checked (reserved keys such as `generic`, duplicate keys,
 * severities, key shape, sizes), because the repository writes whatever it is given.
 */
function parseTypes(types: CatalogTypeInput[]): CatalogTypeInput[] {
  const parsed = CatalogPutInput.safeParse({ types });
  if (parsed.success) return parsed.data.types;
  const detail = parsed.error.issues
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ')
    .slice(0, MAX_DETAIL_LENGTH);
  throw new ProblemError(422, 'validation_failed', detail);
}

/**
 * Upserts catalog types of an own app (never deletes) and returns the whole catalog. The cheap checks come first:
 * the list itself, then a short read that the app belongs to the tenant, so a caller cannot make the server compile
 * schemas for an app it does not own. Every payload schema is then checked before the write transaction opens; a
 * validator that cannot take the call is a retryable 503, not a 422. The write re-checks ownership.
 */
export async function putCatalog(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  appId: string,
  types: CatalogTypeInput[],
  opts: { via?: 'app_key' } = {},
): Promise<CatalogTypeRow[]> {
  const checked = parseTypes(types);
  const owned = await withTenant(d.db, scope, async (t) => {
    const app = await getApp(t, appId);
    return app !== null && app.ownerWorkspaceId === t.workspaceId;
  });
  if (!owned) throw notFound();
  // One schema at a time: a large catalog must not take every validator worker from event ingest.
  for (const [i, type] of checked.entries()) {
    if (!type.payloadSchema) continue;
    const check = await d.payloadSchemas.checkSchema(type.payloadSchema);
    if (check.ok) continue;
    if (isValidatorUnavailable(check)) {
      throw unavailable(VALIDATOR_BUSY_DETAIL);
    }
    throw new ProblemError(422, 'validation_failed', `types.${i}.payloadSchema: ${check.detail}`);
  }
  return withTenant(d.db, scope, async (t) => {
    const ok = await upsertCatalogTypes(
      t,
      appId,
      checked.map((type) => ({
        key: type.key,
        name: type.name,
        description: type.description ?? null,
        defaultSeverity: type.defaultSeverity,
        payloadSchema: type.payloadSchema ?? null,
      })),
      actor,
      opts,
    );
    if (!ok) throw notFound();
    return listCatalog(t, appId);
  });
}
