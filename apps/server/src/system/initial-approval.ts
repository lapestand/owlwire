import type { AppRow, AuditActor, OwlwireDb } from '@owlwire/db';
import { SYSTEM, setApprovalStatus, withSystem } from '@owlwire/db/system';

/**
 * Approval that comes from the server configuration, never from the request: an instance admin created the
 * public app, or the edition does not require approval. The tenant transaction cannot write it (the
 * apps_approval_guard trigger), so it runs in system mode after the app was created; app.approval_changed records
 * the reason as its note.
 */
export async function approveNewPublicApp(
  db: OwlwireDb,
  appId: string,
  actor: AuditActor,
  reason: 'instance_admin' | 'approval_not_required',
): Promise<AppRow> {
  const result = await withSystem(db, SYSTEM, (s) =>
    setApprovalStatus(s, appId, 'approved', actor, reason),
  );
  if (!result) throw new Error('approveNewPublicApp: app is not a public app');
  const { ownerWorkspaceName: _name, ...app } = result.app;
  return app;
}
