import { isUuid } from '@owlwire/core';
import { type OwlwireDb, TENANT_JOB_PAYLOAD_KEY, type TenantScope } from '@owlwire/db';
import type { Logger } from 'pino';
import { resolveTenant, type TenantEntityKind } from '../system/tenant-resolver.js';

/**
 * Task 12 ruling: a worker never trusts the payload for scope. The workspace is resolved from the entity id in a
 * system transaction (closed before the tenant scope opens) and must equal the `_ws` that enqueueJob stamped from
 * the enqueuing TenantTx. A missing or different `_ws` means the job was not enqueued by that workspace (e.g. a
 * tenant enqueued a foreign id into its own namespace): the job is dropped with a warning (ids only) and not thrown,
 * so it is not retried. An unknown id is dropped the same way (P0 behaviour).
 */
export async function resolveJobTenant(
  db: OwlwireDb,
  log: Pick<Logger, 'warn'>,
  job: { task: string; kind: TenantEntityKind; id: string; payloadWorkspace: unknown },
): Promise<TenantScope | null> {
  const scope = await resolveTenant(db, job.kind, job.id);
  if (!scope) {
    log.warn({ [`${job.kind}Id`]: job.id }, `${job.task}: ${job.kind} not found`);
    return null;
  }
  if (job.payloadWorkspace !== scope.workspaceId) {
    const ws = job.payloadWorkspace;
    log.warn(
      {
        [`${job.kind}Id`]: job.id,
        workspaceId: scope.workspaceId,
        jobWorkspaceId: isUuid(ws) ? ws : null,
        jobWorkspaceKey: TENANT_JOB_PAYLOAD_KEY,
      },
      `${job.task}: job workspace does not match the ${job.kind}; dropping the job`,
    );
    return null;
  }
  return scope;
}
