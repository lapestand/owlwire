import type { InstallationCreateInput } from '@owlwire/contracts';
import { issueToken } from '@owlwire/crypto';
import {
  type AuditActor,
  createInstallation,
  getApp,
  getInstallation,
  getInstallationWithApp,
  getSourceTemplate,
  type InstallationWithApp,
  listCatalog,
  RepoNotFoundError,
  revokeInstallation,
  setInstallationSourceTemplate,
  type TenantScope,
  type TenantTx,
  updateInstallationGrants,
  withTenant,
} from '@owlwire/db';
import { notFound, ProblemError } from '../errors.js';
import { type ServiceDeps, userIdOf } from './types.js';

const UNKNOWN_TYPE_DETAIL = 'grantedTypes contains a type that is not in the app catalog.';
const REVOKED_DETAIL = 'The installation is revoked.';
const UNKNOWN_TEMPLATE_DETAIL = 'unknown source template';

/** A template of another workspace and a missing one look the same. */
async function assertTemplateExists(t: TenantTx, id: string | null | undefined): Promise<void> {
  if (id === undefined || id === null) return;
  if (!(await getSourceTemplate(t, id))) {
    throw new ProblemError(422, 'validation_failed', UNKNOWN_TEMPLATE_DETAIL);
  }
}

/** Deduplicated grants that all exist in the app's catalog; null (or absent) grants the whole catalog. */
async function validateGrants(
  t: TenantTx,
  appId: string,
  grantedTypes: string[] | null | undefined,
): Promise<string[] | null> {
  if (grantedTypes === undefined || grantedTypes === null) return null;
  const unique = [...new Set(grantedTypes)];
  const known = new Set((await listCatalog(t, appId)).map((type) => type.key));
  if (unique.some((key) => !known.has(key))) {
    throw new ProblemError(422, 'unknown_type', UNKNOWN_TYPE_DETAIL);
  }
  return unique;
}

function sameGrants(a: string[] | null, b: string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((key, i) => key === b[i]);
}

async function withApp(t: TenantTx, id: string): Promise<InstallationWithApp> {
  const row = await getInstallationWithApp(t, id);
  if (!row) throw notFound();
  return row;
}

/**
 * Installs an app this workspace can see: its own app, or an approved public app of another workspace. Anything
 * else is a 404; the owner's own public app that is pending or rejected is 403 app_not_approved.
 */
export async function createWorkspaceInstallation(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  input: InstallationCreateInput,
): Promise<{ installation: InstallationWithApp; token: string }> {
  return withTenant(d.db, scope, async (t) => {
    // getApp returns own apps and approved public apps only (the same rule as RLS).
    const app = await getApp(t, input.appId);
    if (!app) throw notFound();
    if (app.approvalStatus !== 'approved') {
      throw new ProblemError(
        403,
        'app_not_approved',
        `The app is ${app.approvalStatus} and cannot be installed yet.`,
      );
    }
    const grantedTypes = await validateGrants(t, app.id, input.grantedTypes);
    await assertTemplateExists(t, input.sourceTemplateId);
    const issued = issueToken('inst');
    const created = await createInstallation(
      t,
      {
        appId: app.id,
        tokenHash: issued.hash,
        tokenPrefix: issued.prefix,
        externalRef: input.externalRef ?? null,
        grantedTypes,
        sourceTemplateId: input.sourceTemplateId ?? null,
        createdByUserId: userIdOf(actor),
      },
      actor,
    );
    return { installation: await withApp(t, created.id), token: issued.token };
  });
}

/**
 * Replaces the grants of an active installation (null grants the whole catalog). A revoked installation is a 409.
 * Grants equal to the current ones (after deduplication) change nothing and write no audit row.
 */
export async function changeInstallationGrants(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  installationId: string,
  grantedTypes: string[] | null,
): Promise<InstallationWithApp> {
  return withTenant(d.db, scope, async (t) => {
    const current = await getInstallation(t, installationId);
    if (!current) throw notFound();
    if (current.status === 'revoked') throw new ProblemError(409, 'conflict', REVOKED_DETAIL);
    const validated = await validateGrants(t, current.appId, grantedTypes);
    if (sameGrants(current.grantedTypes, validated)) return withApp(t, installationId);
    const updated = await updateInstallationGrants(t, installationId, validated, actor);
    // Revoked by a concurrent request between the read and the update.
    if (!updated) throw new ProblemError(409, 'conflict', REVOKED_DETAIL);
    return withApp(t, installationId);
  });
}

/**
 * Binds an active installation to a source template of the same workspace, or unbinds it with null. A revoked
 * installation is a 409; an unknown or foreign template is a 422. Binding the current template changes nothing.
 */
export async function changeInstallationSourceTemplate(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  installationId: string,
  sourceTemplateId: string | null,
): Promise<InstallationWithApp> {
  return withTenant(d.db, scope, async (t) => {
    const current = await getInstallation(t, installationId);
    if (!current) throw notFound();
    if (current.status === 'revoked') throw new ProblemError(409, 'conflict', REVOKED_DETAIL);
    await assertTemplateExists(t, sourceTemplateId);
    const updated = await setInstallationSourceTemplate(t, installationId, sourceTemplateId, actor);
    // Revoked by a concurrent request between the read and the update.
    if (!updated) throw new ProblemError(409, 'conflict', REVOKED_DETAIL);
    return withApp(t, installationId);
  });
}

/** Idempotent: revoking an already revoked installation succeeds without a second audit row. */
export async function revokeWorkspaceInstallation(
  d: ServiceDeps,
  scope: TenantScope,
  actor: AuditActor,
  installationId: string,
): Promise<void> {
  try {
    await withTenant(d.db, scope, (t) =>
      revokeInstallation(t, installationId, actor, { reason: 'workspace' }),
    );
  } catch (err) {
    if (err instanceof RepoNotFoundError) throw notFound();
    throw err;
  }
}
