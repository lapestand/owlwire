import { newId } from '@owlwire/core';
import type { OwlwireDb } from '../handle.js';
import { SYSTEM_ACTOR } from '../repos/audit.js';
import { createWorkspace } from '../repos/workspaces.js';
import { tenantScope, withTenant } from '../scope.js';

export async function createTestWorkspace(db: OwlwireDb, label: string): Promise<string> {
  const id = newId();
  await withTenant(db, tenantScope(id), (t) =>
    createWorkspace(
      t,
      { name: label, slug: `${label}-${id.slice(-12)}`, kind: 'community' },
      SYSTEM_ACTOR,
    ),
  );
  return id;
}
