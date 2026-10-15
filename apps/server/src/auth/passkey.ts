import type { PasskeyOptions } from '@better-auth/passkey';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';

/**
 * WebAuthn relying party: passkeys are bound to the host of OWLWIRE_PUBLIC_URL, and registration and sign-in
 * responses must come from that exact origin (never from the origin a client claims).
 */
export function passkeyRelyingParty(baseURL: string): { rpID: string; origin: string } {
  const url = new URL(baseURL);
  return { rpID: url.hostname, origin: url.origin };
}

/**
 * A passkey sign-in skips both the password and TOTP, so it must prove two factors itself: possession of the key
 * and user verification (PIN or biometric) on the authenticator. The library asks for verification only as
 * "preferred" and does not require it, so a response without it is refused here.
 */
export function assertUserVerified(info: { userVerified?: boolean } | undefined): void {
  if (info?.userVerified !== true) {
    throw new APIError('UNAUTHORIZED', {
      code: 'USER_VERIFICATION_REQUIRED',
      message: 'The authenticator did not verify the user',
    });
  }
}

export function passkeyOptions(baseURL: string): PasskeyOptions {
  const { rpID, origin } = passkeyRelyingParty(baseURL);
  return {
    rpID,
    rpName: 'Owlwire',
    origin,
    authenticatorSelection: { userVerification: 'required' },
    registration: {
      afterVerification: ({ verification }) => {
        assertUserVerified(verification.registrationInfo);
      },
    },
    authentication: {
      afterVerification: ({ verification }) => {
        assertUserVerified(verification.authenticationInfo);
      },
    },
    schema: { passkey: { modelName: 'auth_passkey' } },
  };
}

/**
 * The library builds sign-in options with userVerification "preferred" and has no option for it; this asks the
 * browser for "required" so the authenticator prompts for the PIN or biometric. The server check above is what
 * enforces it.
 */
export function passkeyUserVerificationRequest(): BetterAuthPlugin {
  return {
    id: 'owlwire-passkey-user-verification',
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === '/passkey/generate-authenticate-options',
          handler: createAuthMiddleware(async (ctx) => {
            const returned = ctx.context.returned;
            if (!returned || typeof returned !== 'object' || !('challenge' in returned)) return;
            return ctx.json({ ...returned, userVerification: 'required' });
          }),
        },
      ],
    },
  };
}
