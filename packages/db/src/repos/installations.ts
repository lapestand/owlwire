import { isUuid, newId } from '@owlwire/core';
import { and, asc, eq, getTableColumns } from 'drizzle-orm';
import { mapPgErrors, RepoInputError, RepoNotFoundError } from '../errors.js';
import { apps, installations } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { getApp } from './apps.js';
import { type AuditActor, writeAudit } from './audit.js';
import { assertIdShape, now, q } from './context.js';
import { getSourceTemplate } from './source-templates.js';

type InstallationSelect = typeof installations.$inferSelect;
/** Token hash'i satır tipinde yoktur; token ile kimlik doğrulama yalnız `@owlwire/db/system` üzerindendir. */
export type InstallationRow = Omit<InstallationSelect, 'tokenHash'>;

/** `installation.revoked` denetim kaydının `data.reason` değerleri (son üçünü bağlantı akışı kullanacak). */
export type InstallationRevokeReason =
  | 'workspace'
  | 'app'
  | 'replaced_by_link'
  | 'link_unclaimed'
  | 'app_rejected';

const { tokenHash: _tokenHash, ...installationColumns } = getTableColumns(installations);

export interface CreateInstallationInput {
  appId: string;
  tokenHash: string;
  tokenPrefix: string;
  externalRef?: string | null;
  grantedTypes?: string[] | null;
  createdByUserId?: string | null;
  sourceTemplateId?: string | null;
}

const byId = (t: TenantTx, id: string) =>
  and(eq(installations.workspaceId, t.workspaceId), eq(installations.id, id));

/** A template that is not in this workspace (another workspace's included) is `RepoNotFoundError('source_template')`. */
async function assertSourceTemplate(t: TenantTx, id: string): Promise<void> {
  assertIdShape('source_template', id);
  if (!(await getSourceTemplate(t, id))) throw new RepoNotFoundError('source_template', id);
}

/**
 * FK denetimi RLS'i yok saydığından başka workspace'in private (görünmez) app'ine kurulum satırı DB'de
 * yazılabilir; bu yüzden app önce `getApp` ile (kendi app'i ya da onaylı public app) görünürlük açısından
 * denetlenir. Görünmeyen app `RepoNotFoundError('app', appId)`.
 * App satırı kilitlenmez (başka workspace'in public app'i için kiracı RLS'i `FOR SHARE`'e izin vermez):
 * onay aynı anda geri çekilirse kurulum oluşabilir; token kullanımındaki onay denetimi bu kurulumun
 * token'ını reddeder.
 */
export async function createInstallation(
  t: TenantTx,
  input: CreateInstallationInput,
  actor: AuditActor,
): Promise<InstallationRow> {
  assertIdShape('app', input.appId);
  if (input.createdByUserId != null && !isUuid(input.createdByUserId)) {
    throw new RepoInputError('installation', 'createdByUserId must be a uuid');
  }
  const app = await getApp(t, input.appId);
  if (!app) throw new RepoNotFoundError('app', input.appId);
  const sourceTemplateId = input.sourceTemplateId ?? null;
  if (sourceTemplateId !== null) await assertSourceTemplate(t, sourceTemplateId);
  const id = newId();
  const rows = await mapPgErrors('installation', id, () =>
    q(t)
      .insert(installations)
      .values({
        id,
        appId: input.appId,
        workspaceId: t.workspaceId,
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        externalRef: input.externalRef ?? null,
        grantedTypes: input.grantedTypes ?? null,
        createdByUserId: input.createdByUserId ?? null,
        sourceTemplateId,
        createdAt: now(t),
      })
      .returning(installationColumns),
  );
  const row = rows[0];
  if (!row) throw new Error('installation insert returned no row');
  await writeAudit(t, {
    action: 'installation.created',
    actor,
    targetType: 'installation',
    targetId: id,
    data: { appId: input.appId, tokenPrefix: input.tokenPrefix, sourceTemplateId },
  });
  return row;
}

export async function getInstallation(t: TenantTx, id: string): Promise<InstallationRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q(t).select(installationColumns).from(installations).where(byId(t, id));
  return rows[0] ?? null;
}

export async function listInstallations(t: TenantTx): Promise<InstallationRow[]> {
  return q(t)
    .select(installationColumns)
    .from(installations)
    .where(eq(installations.workspaceId, t.workspaceId))
    .orderBy(asc(installations.createdAt), asc(installations.id));
}

/** İdempotent: zaten iptal edilmişse sessizce döner, ikinci denetim kaydı yazmaz. Başka workspace'inki `RepoNotFoundError`. */
export async function revokeInstallation(
  t: TenantTx,
  id: string,
  actor: AuditActor,
  opts: { reason?: InstallationRevokeReason } = {},
): Promise<void> {
  assertIdShape('installation', id);
  const changed = await q(t)
    .update(installations)
    .set({ status: 'revoked', revokedAt: now(t) })
    .where(and(byId(t, id), eq(installations.status, 'active')))
    .returning({ appId: installations.appId, tokenPrefix: installations.tokenPrefix });
  const row = changed[0];
  if (!row) {
    if (await getInstallation(t, id)) return;
    throw new RepoNotFoundError('installation', id);
  }
  await writeAudit(t, {
    action: 'installation.revoked',
    actor,
    targetType: 'installation',
    targetId: id,
    data: { appId: row.appId, tokenPrefix: row.tokenPrefix, reason: opts.reason ?? 'workspace' },
  });
}

export type InstallationWithApp = InstallationRow & {
  appName: string | null;
  appVisibility: 'private' | 'public' | null;
};

const withAppColumns = {
  ...installationColumns,
  appName: apps.name,
  appVisibility: apps.visibility,
};

/** Left join: an app that is no longer visible to this workspace (RLS) yields null app fields. */
export async function listInstallationsWithApp(t: TenantTx): Promise<InstallationWithApp[]> {
  const rows = await q(t)
    .select(withAppColumns)
    .from(installations)
    .leftJoin(apps, eq(apps.id, installations.appId))
    .where(eq(installations.workspaceId, t.workspaceId))
    .orderBy(asc(installations.createdAt), asc(installations.id));
  return rows as InstallationWithApp[];
}

export async function getInstallationWithApp(
  t: TenantTx,
  id: string,
): Promise<InstallationWithApp | null> {
  if (!isUuid(id)) return null;
  const rows = await q(t)
    .select(withAppColumns)
    .from(installations)
    .leftJoin(apps, eq(apps.id, installations.appId))
    .where(byId(t, id));
  return (rows[0] as InstallationWithApp | undefined) ?? null;
}

/** Changes the grants of an active installation; returns null when there is no active installation with this id. */
export async function updateInstallationGrants(
  t: TenantTx,
  id: string,
  grantedTypes: string[] | null,
  actor: AuditActor,
): Promise<InstallationRow | null> {
  if (!isUuid(id)) return null;
  const rows = await q(t)
    .update(installations)
    .set({ grantedTypes })
    .where(and(byId(t, id), eq(installations.status, 'active')))
    .returning(installationColumns);
  const row = rows[0];
  if (!row) return null;
  await writeAudit(t, {
    action: 'installation.updated',
    actor,
    targetType: 'installation',
    targetId: id,
    data: { grantedTypes },
  });
  return row;
}

/**
 * Binds an active installation to a source template of this workspace, or unbinds it with null. Returns null when
 * there is no active installation with this id. Writes an audit row only when the binding changes.
 */
export async function setInstallationSourceTemplate(
  t: TenantTx,
  installationId: string,
  sourceTemplateId: string | null,
  actor: AuditActor,
): Promise<InstallationRow | null> {
  if (!isUuid(installationId)) return null;
  if (sourceTemplateId !== null) await assertSourceTemplate(t, sourceTemplateId);
  const current = await q(t)
    .select(installationColumns)
    .from(installations)
    .where(and(byId(t, installationId), eq(installations.status, 'active')))
    .for('update');
  const row = current[0];
  if (!row) return null;
  if (row.sourceTemplateId === sourceTemplateId) return row;
  const rows = await mapPgErrors(
    'installation',
    installationId,
    () =>
      q(t)
        .update(installations)
        .set({ sourceTemplateId })
        .where(byId(t, installationId))
        .returning(installationColumns),
    {
      fkNotFound: {
        installations_source_template_ws_fk: {
          entity: 'source_template',
          id: sourceTemplateId ?? '',
        },
      },
    },
  );
  const updated = rows[0];
  if (!updated) return null;
  await writeAudit(t, {
    action: 'installation.updated',
    actor,
    targetType: 'installation',
    targetId: installationId,
    data: { sourceTemplateId },
  });
  return updated;
}
