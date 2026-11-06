import { z } from '@hono/zod-openapi';
import { CatalogType } from './catalog.js';
import { InstallationView } from './installations.js';

export const AppCreateInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    visibility: z.enum(['private', 'public']),
    description: z.string().max(1000).optional(),
    homepageUrl: z.string().url().optional(),
  })
  .openapi('AppCreateInput');
export type AppCreateInput = z.infer<typeof AppCreateInput>;

export const AppView = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    visibility: z.enum(['private', 'public']),
    approvalStatus: z.enum(['approved', 'pending', 'rejected']),
    description: z.string().nullable(),
    homepageUrl: z.string().nullable(),
    ownerWorkspaceId: z.string().uuid(),
    appKeyPrefix: z.string().nullable(),
    createdAt: z.string(),
  })
  .openapi('AppView');
export type AppView = z.infer<typeof AppView>;

export const AppDetail = AppView.extend({ catalog: z.array(CatalogType) }).openapi('AppDetail');
export type AppDetail = z.infer<typeof AppDetail>;

export const AvailableApp = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    visibility: z.enum(['private', 'public']),
    approvalStatus: z.enum(['approved', 'pending', 'rejected']),
    description: z.string().nullable(),
    homepageUrl: z.string().nullable(),
    owned: z.boolean(),
    catalog: z.array(CatalogType),
  })
  .openapi('AvailableApp');
export type AvailableApp = z.infer<typeof AvailableApp>;

export const AppListResponse = z.object({ items: z.array(AppView) }).openapi('AppListResponse');
export type AppListResponse = z.infer<typeof AppListResponse>;

export const AvailableAppListResponse = z
  .object({ items: z.array(AvailableApp) })
  .openapi('AvailableAppListResponse');
export type AvailableAppListResponse = z.infer<typeof AvailableAppListResponse>;

export const AppCreatedResponse = z
  .object({
    app: AppView,
    appKey: z.string().nullable(),
    installation: InstallationView.nullable(),
    token: z.string().nullable(),
  })
  .openapi('AppCreatedResponse');
export type AppCreatedResponse = z.infer<typeof AppCreatedResponse>;

export const AppKeyRotatedResponse = z
  .object({
    appKey: z.string(),
    appKeyPrefix: z.string(),
    previousKeyExpiresAt: z.string().nullable(),
  })
  .openapi('AppKeyRotatedResponse');
export type AppKeyRotatedResponse = z.infer<typeof AppKeyRotatedResponse>;

/** One decision endpoint for approving or rejecting a public app. */
export const ApprovalDecisionInput = z
  .object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().trim().min(1).max(1000).optional(),
    revokeInstallations: z.boolean().optional(),
  })
  .openapi('ApprovalDecisionInput');
export type ApprovalDecisionInput = z.infer<typeof ApprovalDecisionInput>;

export const AppApprovalItem = AppView.extend({ ownerWorkspaceName: z.string() }).openapi(
  'AppApprovalItem',
);
export type AppApprovalItem = z.infer<typeof AppApprovalItem>;

export const AppApprovalListResponse = z
  .object({ items: z.array(AppApprovalItem) })
  .openapi('AppApprovalListResponse');
export type AppApprovalListResponse = z.infer<typeof AppApprovalListResponse>;
