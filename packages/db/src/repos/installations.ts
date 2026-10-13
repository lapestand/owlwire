import { isUuid, newId } from '@owlwire/core';
import { and, asc, eq, getTableColumns } from 'drizzle-orm';
import { mapPgErrors, RepoInputError, RepoNotFoundError } from '../errors.js';
import { installations } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { getApp } from './apps.js';
import { type AuditActor, writeAudit } from './audit.js';
import { assertIdShape, now, q } from './context.js';

type InstallationSelect = typeof installations.$inferSelect;
/** Token hash'i satır tipinde yoktur; token ile kimlik doğrulama yalnız `@owlwire/db/system` üzerindendir. */
export type InstallationRow = Omit<InstallationSelect, 'tokenHash'>;

/** Sözleşme §6.4 `installation.revoked` `data.reason` değerleri (P1x link akışı son üçünü kullanır). */
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
}

const byId = (t: TenantTx, id: string) =>
  and(eq(installations.workspaceId, t.workspaceId), eq(installations.id, id));

/**
 * FK denetimi RLS'i yok saydığından başka workspace'in private (görünmez) app'ine kurulum satırı DB'de
 * yazılabilir; bu yüzden app önce `getApp` ile (kendi app'i ya da onaylı public app) görünürlük açısından
 * denetlenir. Görünmeyen app `RepoNotFoundError('app', appId)`.
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
    data: { appId: input.appId, tokenPrefix: input.tokenPrefix },
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
