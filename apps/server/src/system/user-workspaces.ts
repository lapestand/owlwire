import { randomBytes } from 'node:crypto';
import { generateSlug, newId } from '@owlwire/core';
import {
  addMembership,
  createWorkspace,
  RepoConflictError,
  tenantScope,
  toWorkspaceSummary,
  withTenant,
} from '@owlwire/db';
import { listMembershipsForUser, SYSTEM, withSystem } from '@owlwire/db/system';
import type { BaseDeps } from '../base-deps.js';
import { ProblemError } from '../http/problem.js';
import type { WorkspaceContext } from '../http/routes/api/env.js';

/** Generated slugs carry a random 6 hex suffix; a collision is retried with a new suffix this many times. */
const SLUG_ATTEMPTS = 5;

/** Every live workspace the user belongs to, with the user's role, oldest first. */
export async function listWorkspacesForUser(
  deps: Pick<BaseDeps, 'db'>,
  userId: string,
): Promise<WorkspaceContext[]> {
  const rows = await withSystem(deps.db, SYSTEM, (s) => listMembershipsForUser(s, userId));
  return rows.map((r) => ({ ...r.workspace, role: r.role }));
}

/**
 * Creates a community workspace (with its data key and workspace.created) and makes `userId` its owner
 * (member.added), in one transaction. `input.slug` must already be a valid user-chosen slug; without one a slug is
 * generated from the name. A taken slug the user picked, or repeated collisions of generated ones, answer
 * 409 slug_taken.
 */
export async function createCommunityWorkspace(
  deps: Pick<BaseDeps, 'db'>,
  userId: string,
  input: { name: string; slug?: string | undefined },
): Promise<WorkspaceContext> {
  const actor = { kind: 'user' as const, userId };
  const attempts = input.slug === undefined ? SLUG_ATTEMPTS : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const slug = input.slug ?? generateSlug(input.name, randomBytes(3).toString('hex'));
    try {
      return await withTenant(deps.db, tenantScope(newId()), async (t) => {
        const ws = await createWorkspace(t, { name: input.name, slug, kind: 'community' }, actor);
        await addMembership(t, { userId, role: 'owner', via: 'create' }, actor);
        return { ...toWorkspaceSummary(ws), role: 'owner' as const };
      });
    } catch (err) {
      if (!(err instanceof RepoConflictError)) throw err;
    }
  }
  throw new ProblemError(409, 'conflict', 'slug_taken');
}
