import type { AppApprovalItem, AppView, CatalogType, InstallationView } from '@owlwire/contracts';
import type { AppRow, CatalogTypeRow, InstallationWithApp } from '@owlwire/db';

/**
 * Text columns that check constraints keep to a fixed set. A value outside the set means the schema and the API
 * contract disagree, which is a server bug, not something to pass on to clients.
 */
function oneOf<T extends string>(allowed: readonly T[], value: string, column: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`unexpected ${column} value`);
}

const VISIBILITIES = ['private', 'public'] as const;
const APPROVAL_STATUSES = ['approved', 'pending', 'rejected'] as const;
const INSTALLATION_STATUSES = ['active', 'revoked'] as const;

/** API views of repository rows: camelCase fields, ISO 8601 times, no secret or hash columns. */
export function toCatalogTypeView(row: CatalogTypeRow): CatalogType {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    defaultSeverity: row.defaultSeverity,
    payloadSchema: row.payloadSchema,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** @public App view of the management API (app list, detail and creation answers). */
export function toAppView(row: AppRow): AppView {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    visibility: oneOf(VISIBILITIES, row.visibility, 'apps.visibility'),
    approvalStatus: oneOf(APPROVAL_STATUSES, row.approvalStatus, 'apps.approval_status'),
    description: row.description,
    homepageUrl: row.homepageUrl,
    ownerWorkspaceId: row.ownerWorkspaceId,
    appKeyPrefix: row.appKeyPrefix,
    createdAt: row.createdAt.toISOString(),
  };
}

/** @public Item of the instance admin approval queue. */
export function toAppApprovalItem(row: AppRow & { ownerWorkspaceName: string }): AppApprovalItem {
  return { ...toAppView(row), ownerWorkspaceName: row.ownerWorkspaceName };
}

/** @public Installation view of the management API. */
export function toInstallationView(row: InstallationWithApp): InstallationView {
  return {
    id: row.id,
    appId: row.appId,
    appName: row.appName,
    appVisibility: row.appVisibility,
    workspaceId: row.workspaceId,
    status: oneOf(INSTALLATION_STATUSES, row.status, 'installations.status'),
    externalRef: row.externalRef,
    grantedTypes: row.grantedTypes,
    sourceTemplateId: row.sourceTemplateId,
    tokenPrefix: row.tokenPrefix,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}
