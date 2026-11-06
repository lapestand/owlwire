import { z } from '@hono/zod-openapi';
import { TypeKey } from './events.js';

export const InstallationView = z
  .object({
    id: z.string().uuid(),
    appId: z.string().uuid(),
    /** null when the app is no longer visible to this workspace (e.g. a public app that lost its approval). */
    appName: z.string().nullable(),
    appVisibility: z.enum(['private', 'public']).nullable(),
    workspaceId: z.string().uuid(),
    status: z.enum(['active', 'revoked']),
    externalRef: z.string().nullable(),
    grantedTypes: z.array(z.string()).nullable(),
    tokenPrefix: z.string(),
    createdAt: z.string(),
    revokedAt: z.string().nullable(),
  })
  .openapi('InstallationView');
export type InstallationView = z.infer<typeof InstallationView>;

export const InstallationListResponse = z
  .object({ items: z.array(InstallationView) })
  .openapi('InstallationListResponse');
export type InstallationListResponse = z.infer<typeof InstallationListResponse>;

const GrantedTypes = z.array(TypeKey).min(1).max(200).nullable();

export const InstallationCreateInput = z
  .object({
    appId: z.string().uuid(),
    grantedTypes: GrantedTypes.optional(),
    externalRef: z.string().min(1).max(256).optional(),
  })
  .strict()
  .openapi('InstallationCreateInput');
export type InstallationCreateInput = z.infer<typeof InstallationCreateInput>;

export const InstallationUpdateInput = z
  .object({ grantedTypes: GrantedTypes })
  .strict()
  .openapi('InstallationUpdateInput');
export type InstallationUpdateInput = z.infer<typeof InstallationUpdateInput>;

export const InstallationCreatedResponse = z
  .object({ installation: InstallationView, token: z.string() })
  .openapi('InstallationCreatedResponse');
export type InstallationCreatedResponse = z.infer<typeof InstallationCreatedResponse>;
