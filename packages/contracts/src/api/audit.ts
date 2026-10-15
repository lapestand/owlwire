import { z } from 'zod';

/** `GET /api/workspaces/{workspaceId}/audit` query: newest first, keyset cursor, optional action filter. */
export const AuditQuery = z.object({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().max(64).optional(),
});
export const AuditEntrySchema = z.object({
  id: z.uuid(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  /** The actor as one object; `name` is null when it is not known (a former member, an installation, the system). */
  actor: z.object({
    type: z.enum(['user', 'installation', 'system']),
    id: z.uuid().nullable(),
    name: z.string().nullable(),
  }),
  data: z.record(z.string(), z.unknown()),
  createdAt: z.string(),
});
export const AuditListSchema = z.object({
  items: z.array(AuditEntrySchema),
  nextCursor: z.string().nullable(),
});
export type AuditEntryDto = z.infer<typeof AuditEntrySchema>;
