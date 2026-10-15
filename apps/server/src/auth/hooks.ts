import { decideRegistration } from '@owlwire/core';
import type { BaseDeps } from '../base-deps.js';
import { ensurePersonalWorkspace } from '../system/personal-workspace.js';
import { getRegistrationMode, hasPendingInvitation } from '../system/registration.js';
import { type AuthHooks, RegistrationDeniedError } from './auth.js';
import { isBootstrap } from './bootstrap-context.js';

/**
 * The registration gate (mode, invitation, bootstrap bypass) before a user row is written, and the personal workspace
 * after it. Both run on the application role: settings, invitations and workspaces are not auth tables.
 */
export function createAuthHooks(deps: BaseDeps): AuthHooks {
  return {
    async beforeUserCreate(email) {
      const mode = await getRegistrationMode(deps);
      const decision = decideRegistration({
        mode,
        bootstrap: isBootstrap(),
        hasPendingInvitation: mode === 'invite' ? await hasPendingInvitation(deps, email) : false,
      });
      if (!decision.allowed) throw new RegistrationDeniedError(decision.reason);
    },
    async afterUserCreate(user) {
      await ensurePersonalWorkspace(deps, user);
    },
  };
}
