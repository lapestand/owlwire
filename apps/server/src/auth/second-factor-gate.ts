import type { BetterAuthPlugin } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';
import { deleteSessionCookie } from 'better-auth/cookies';
import { generateRandomString } from 'better-auth/crypto';

/**
 * Where a social sign-in that still needs the second factor lands: the web app's code step, which posts the code to
 * /api/auth/two-factor/verify-totp or /verify-backup-code. The page receives the original destination as
 * `callbackURL`.
 */
export const TWO_FACTOR_CHALLENGE_PATH = '/sign-in/two-factor';

/**
 * Pending second-factor state, in the shape the two-factor plugin issues after a password sign-in and reads back
 * in its verify endpoints. The names are the plugin's own (not exported by the library); the integration tests pin
 * them by completing a challenge issued here.
 */
const TWO_FACTOR_COOKIE = 'two_factor';
const CHALLENGE_PREFIX = '2fa-';
const ATTEMPTS_PREFIX = '2fa-attempts-';
const CHALLENGE_MAX_AGE_SECONDS = 600;

/**
 * Callback error codes that depend on whether an account exists for the provider address. An unverified address
 * with no account fails user creation (`email_not_verified`, with a description); with an account it fails linking
 * (`account_not_linked`). Both are answered as the second, without a description.
 */
const ACCOUNT_DEPENDENT_ERRORS = new Set(['email_not_verified', 'account_not_linked']);
const COLLAPSED_ERROR = 'account_not_linked';

function isCallback(ctx: { path?: string }): boolean {
  return (ctx.path ?? '').startsWith('/callback/');
}

/** The callback's error redirect with an account-dependent code collapsed; null when there is nothing to change. */
function collapsedErrorLocation(location: string, baseURL: string): string | null {
  const origin = new URL(baseURL).origin;
  let url: URL;
  try {
    url = new URL(location, origin);
  } catch {
    return null;
  }
  // The library appends its code to the error page's own query, so a page that already has `error` carries the
  // library's code as a later value: every value is checked, and all of them are replaced by one.
  if (!url.searchParams.getAll('error').some((e) => ACCOUNT_DEPENDENT_ERRORS.has(e))) return null;
  url.searchParams.delete('error');
  url.searchParams.delete('error_description');
  url.searchParams.set('error', COLLAPSED_ERROR);
  const absolute = /^[a-z][a-z\d+.-]*:/i.test(location);
  return absolute ? url.href : `${url.pathname}${url.search}${url.hash}`;
}

function isSocialSignIn(ctx: { path?: string; body?: unknown }): boolean {
  const path = ctx.path ?? '';
  if (path.startsWith('/callback/')) return true;
  const body = ctx.body as { idToken?: unknown } | undefined;
  return path === '/sign-in/social' && Boolean(body?.idToken);
}

/**
 * The two-factor plugin asks for the second factor only after a password sign-in. This plugin extends it to social
 * sign-in (the OAuth callback and the id-token request): when the user has two-factor authentication on, the session
 * the provider sign-in just created is revoked and its cookies dropped, and the plugin's own challenge is issued in
 * its place, so a TOTP or backup code (with the plugin's attempt cap and account lockout) completes the sign-in.
 * List it after the two-factor plugin.
 *
 * It also answers the callback's account-dependent refusals with one error code, so a provider account carrying
 * someone else's unverified address cannot be used to learn whether that address has an Owlwire account.
 */
export function socialSecondFactorGate(): BetterAuthPlugin {
  return {
    id: 'owlwire-social-second-factor',
    hooks: {
      after: [
        {
          // A refused callback must not tell whether an Owlwire account exists for the provider address.
          matcher: isCallback,
          handler: createAuthMiddleware(async (ctx) => {
            // Only a refusal: a sign-in that created a session redirects to the client's own callbackURL.
            const location = ctx.context.responseHeaders?.get('location');
            if (ctx.context.newSession || !location) return;
            const collapsed = collapsedErrorLocation(location, ctx.context.baseURL);
            if (collapsed !== null) throw ctx.redirect(collapsed);
          }),
        },
        {
          matcher: isSocialSignIn,
          handler: createAuthMiddleware(async (ctx) => {
            const pending = ctx.context.newSession;
            const user = pending?.user as
              | { id: string; twoFactorEnabled?: boolean | null }
              | undefined;
            if (!pending || !user?.twoFactorEnabled) return;

            // Drop the session cookies the sign-in set, then expire them, and revoke the session itself.
            const sessionCookies = new Set(
              Object.values(ctx.context.authCookies).map((c: { name: string }) => c.name),
            );
            const headers = ctx.context.responseHeaders;
            const destination = headers?.get('location') ?? null;
            if (headers) {
              const kept = headers
                .getSetCookie()
                .filter((c) => !sessionCookies.has(c.slice(0, c.indexOf('='))));
              headers.delete('set-cookie');
              for (const c of kept) headers.append('set-cookie', c);
            }
            deleteSessionCookie(ctx, true);
            await ctx.context.internalAdapter.deleteSession(pending.session.token);
            ctx.context.setNewSession(null);

            const identifier = `${CHALLENGE_PREFIX}${generateRandomString(20)}`;
            const expiresAt = new Date(Date.now() + CHALLENGE_MAX_AGE_SECONDS * 1000);
            await ctx.context.internalAdapter.createVerificationValue({
              value: user.id,
              identifier,
              expiresAt,
            });
            await ctx.context.internalAdapter.createVerificationValue({
              value: '0',
              identifier: `${ATTEMPTS_PREFIX}${identifier}`,
              expiresAt,
            });
            const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, {
              maxAge: CHALLENGE_MAX_AGE_SECONDS,
            });
            await ctx.setSignedCookie(
              cookie.name,
              identifier,
              ctx.context.secret,
              cookie.attributes,
            );

            if (!ctx.path.startsWith('/callback/')) {
              return ctx.json({ twoFactorRedirect: true, twoFactorMethods: ['totp'] });
            }
            const origin = new URL(ctx.context.baseURL).origin;
            const target = new URL(TWO_FACTOR_CHALLENGE_PATH, origin);
            if (destination) {
              try {
                const next = new URL(destination, origin);
                if (next.origin === origin) target.searchParams.set('callbackURL', next.href);
              } catch {
                // no destination
              }
            }
            throw ctx.redirect(target.href);
          }),
        },
      ],
    },
  };
}
