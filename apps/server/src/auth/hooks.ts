import { decideRegistration } from '@owlwire/core';
import { SYSTEM_ACTOR } from '@owlwire/db';
import type { BaseDeps } from '../base-deps.js';
import { ensurePersonalWorkspace } from '../system/personal-workspace.js';
import {
  getRegistrationMode,
  hasPendingInvitation,
  invitationAdmits,
} from '../system/registration.js';
import { type AuthHooks, RegistrationDeniedError, type UserCreateContext } from './auth.js';
import { isBootstrap } from './bootstrap-context.js';

/**
 * Whether an invitation admits the new user in invite mode. A social sign-up arrives on the OAuth callback with an
 * address the provider has verified, so a pending invitation for it is enough. Every other creation path (email
 * sign-up, a server-side call without a request, any path added later) must present the token of a pending
 * invitation for the same address: knowing an invited address proves nothing, the token proves the mailbox or the
 * inviter's intent.
 */
function admittedByInvitation(
  deps: BaseDeps,
  email: string,
  context: UserCreateContext,
): Promise<boolean> {
  if (context.path?.startsWith('/callback/')) return hasPendingInvitation(deps, email);
  return invitationAdmits(deps, email, context.invitationToken);
}

/**
 * The registration gate (mode, invitation, bootstrap bypass) before a user row is written, and the personal workspace
 * after it. Both run on the application role: settings, invitations and workspaces are not auth tables.
 */
export function createAuthHooks(deps: BaseDeps): AuthHooks {
  return {
    async beforeUserCreate(email, context) {
      const mode = await getRegistrationMode(deps);
      const bootstrap = isBootstrap();
      const decision = decideRegistration({
        mode,
        bootstrap,
        hasPendingInvitation:
          mode === 'invite' && !bootstrap
            ? await admittedByInvitation(deps, email, context)
            : false,
      });
      if (!decision.allowed) throw new RegistrationDeniedError(decision.reason);
    },
    async afterUserCreate(user) {
      // The command line creates the first admin; the workspace's audit entries name the system, not the user.
      await ensurePersonalWorkspace(deps, user, isBootstrap() ? SYSTEM_ACTOR : undefined);
    },
  };
}
