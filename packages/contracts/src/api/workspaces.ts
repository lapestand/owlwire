import {
  INVITABLE_ROLES,
  isValidSlug,
  SLUG_PATTERN,
  WORKSPACE_NAME_MAX,
  WORKSPACE_ROLES,
  workspaceNameLength,
} from '@owlwire/core';
import { z } from 'zod';

export const WorkspaceRoleSchema = z.enum(WORKSPACE_ROLES);
export const InvitableRoleSchema = z.enum(INVITABLE_ROLES);
export const WorkspaceKindSchema = z.enum(['personal', 'community']);

/** Measured in code points, the same way the server cuts the names it makes itself. */
const WorkspaceName = z
  .string()
  .trim()
  .min(1)
  .refine((s) => workspaceNameLength(s) <= WORKSPACE_NAME_MAX, {
    message: `name must be at most ${WORKSPACE_NAME_MAX} characters`,
  });

/** A slug a user picks: the shared slug shape, not a reserved word and not in the personal workspace namespace. */
const WorkspaceSlug = z
  .string()
  .regex(SLUG_PATTERN, 'slug must be 3-40 characters of a-z, 0-9 and single dashes')
  .refine(isValidSlug, { message: 'slug is reserved' });

export const WorkspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  kind: WorkspaceKindSchema,
  role: WorkspaceRoleSchema,
  createdAt: z.string(),
});
export const WorkspaceListSchema = z.object({ items: z.array(WorkspaceSchema) });
export const CreateWorkspaceInput = z.object({
  name: WorkspaceName,
  slug: WorkspaceSlug.optional(),
});
export const UpdateWorkspaceInput = z
  .object({ name: WorkspaceName.optional(), slug: WorkspaceSlug.optional() })
  .refine((v) => v.name !== undefined || v.slug !== undefined, {
    message: 'name or slug is required',
  });

/** workspaceId is checked by the workspace access middleware (malformed: 404); nested ids must be UUIDs (malformed: 422). */
export const WorkspaceIdParams = z.object({ workspaceId: z.string() });
export const MemberParams = z.object({ workspaceId: z.string(), userId: z.uuid() });
export const InvitationParams = z.object({ workspaceId: z.string(), invitationId: z.uuid() });

/** `email` is present only for owner and admin viewers; plain members see id, name, image and role. */
export const MemberSchema = z.object({
  userId: z.uuid(),
  name: z.string(),
  email: z.string().optional(),
  image: z.string().nullable(),
  role: WorkspaceRoleSchema,
  joinedAt: z.string(),
});
export const MemberListSchema = z.object({ items: z.array(MemberSchema) });
export const UpdateMemberInput = z.object({ role: WorkspaceRoleSchema });
export const TransferOwnershipInput = z.object({ userId: z.uuid() });

export const InvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: InvitableRoleSchema,
  invitedBy: z.uuid().nullable(),
  expiresAt: z.string(),
  createdAt: z.string(),
});
export const InvitationListSchema = z.object({ items: z.array(InvitationSchema) });
export const CreateInvitationInput = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(254)),
  role: InvitableRoleSchema.default('member'),
  locale: z.enum(['tr', 'en']).optional(),
});
export const CreatedInvitationSchema = z.object({
  invitation: InvitationSchema,
  acceptUrl: z.url(),
  emailSent: z.boolean(),
});
export const InvitationTokenInput = z.object({ token: z.string().min(16).max(200) });
export const InvitationPreviewSchema = z.object({
  workspaceName: z.string(),
  email: z.string(),
  role: InvitableRoleSchema,
  expiresAt: z.string(),
});
export const AcceptedInvitationSchema = z.object({
  workspaceId: z.uuid(),
  role: WorkspaceRoleSchema,
});

export type WorkspaceDto = z.infer<typeof WorkspaceSchema>;
export type MemberDto = z.infer<typeof MemberSchema>;
export type InvitationDto = z.infer<typeof InvitationSchema>;
