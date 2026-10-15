import { newId } from '@owlwire/core';
import { authAdapter, type OwlwireDb } from '@owlwire/db';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import type { Logger } from 'pino';
import type { AuthEnv } from '../config/auth-env.js';
import { pickLocale } from '../mail/locale.js';
import { type Mailer, MailMessageError } from '../mail/mailer.js';
import { type MailTemplate, MailTemplateError, renderMail } from '../mail/templates.js';
import { betterAuthLogger } from './auth-logger.js';
import { isBootstrap } from './bootstrap-context.js';

export const AUTH_BASE_PATH = '/api/auth';
export const AUTH_COOKIE_PREFIX = 'owlwire';
export const MIN_PASSWORD_LENGTH = 10;
/**
 * Internal request header carrying the client address to Better Auth's rate limiter. The HTTP mount sets it from the
 * socket (or a trusted proxy's forwarded header) and drops any value the client sent.
 */
export const AUTH_CLIENT_IP_HEADER = 'x-owlwire-client-ip';

/** Sessions live 30 days; Better Auth extends expiry at most once per day of activity. */
export const SESSION_EXPIRES_IN_SECONDS = 60 * 60 * 24 * 30;
export const SESSION_UPDATE_AGE_SECONDS = 60 * 60 * 24;
/** Counters live in auth_rate_limit so every replica enforces the same limits. */
export const AUTH_RATE_LIMIT = { window: 60, max: 100 } as const;
export const SIGN_IN_RATE_LIMIT = { window: 60, max: 5 } as const;
/** Lifetime of password reset links; the reset email states it. */
export const RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS = 60 * 60;
/** Lifetime of email verification links. */
export const EMAIL_VERIFICATION_EXPIRES_IN_SECONDS = 60 * 60;

/** Secure + __Secure- cookies whenever OWLWIRE_PUBLIC_URL is https. */
export function secureCookiesFor(baseURL: string): boolean {
  return new URL(baseURL).protocol === 'https:';
}

/** @public Why a registration hook refused a new user. */
export type RegistrationDeniedReason = 'registration_closed' | 'invitation_required';

export class RegistrationDeniedError extends Error {
  constructor(readonly reason: RegistrationDeniedReason) {
    super(reason);
    this.name = 'RegistrationDeniedError';
  }
}

export interface AuthHooks {
  beforeUserCreate(email: string): Promise<void>;
  afterUserCreate(user: { id: string; name: string; email: string }): Promise<void>;
}

export const noopAuthHooks: AuthHooks = {
  async beforeUserCreate() {},
  async afterUserCreate() {},
};

export interface CreateAuthOptions {
  /** The auth role's handle (owlwire_auth); the application role cannot read the auth tables. */
  db: OwlwireDb;
  env: AuthEnv;
  mailer: Mailer | null;
  logger: Logger;
  hooks: AuthHooks;
  /** Defaults to process.env.NODE_ENV. Outside 'production' mail links may use http (local development). */
  nodeEnv?: string | undefined;
}

type LinkKind = 'verify_email' | 'reset_password';

/** The emailed link was not built: the public URL is http in production. Carries no URL or token. */
class AuthLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthLinkError';
  }
}

/**
 * Builds the emailed link from our own public URL and the bare token, never from the library's URL string: the token
 * is percent-encoded, the scheme must be https (http only outside production), and the callback the user lands on
 * after the link must be on our own origin. The library has already checked the callback against the trusted origins;
 * this keeps a token-carrying redirect on our origin even if that check ever changes.
 */
function buildAuthLink(
  baseURL: string,
  allowHttp: boolean,
  kind: LinkKind,
  token: string,
  libraryUrl: string,
): string {
  const base = new URL(baseURL);
  if (base.protocol !== 'https:' && !(allowHttp && base.protocol === 'http:')) {
    throw new AuthLinkError('OWLWIRE_PUBLIC_URL must be https for emailed links in production');
  }
  let requested: string | null = null;
  try {
    requested = new URL(libraryUrl).searchParams.get('callbackURL');
  } catch {
    requested = null;
  }
  const fallback = kind === 'reset_password' ? '/reset-password' : '/';
  let callback = new URL(fallback, base);
  if (requested) {
    try {
      const candidate = new URL(requested, base);
      if (candidate.origin === base.origin) callback = candidate;
    } catch {
      // keep the fallback
    }
  }
  const prefix = `${base.origin}${AUTH_BASE_PATH}`;
  const link =
    kind === 'reset_password'
      ? new URL(`${prefix}/reset-password/${encodeURIComponent(token)}`)
      : new URL(`${prefix}/verify-email`);
  if (kind === 'verify_email') link.searchParams.set('token', token);
  link.searchParams.set('callbackURL', callback.href);
  return link.href;
}

/** Log fields for a failed auth email: the kind and the error's class and code, never the link, address or message. */
function mailFailure(kind: string, err: unknown): Record<string, unknown> {
  const reason =
    err instanceof MailTemplateError ||
    err instanceof MailMessageError ||
    err instanceof AuthLinkError
      ? err.name
      : 'transport';
  const code = (err as { code?: unknown } | null)?.code;
  return { kind, reason, ...(typeof code === 'string' ? { code } : {}) };
}

export function createAuth(o: CreateAuthOptions) {
  const emailEnabled = o.mailer !== null;
  const allowHttpLinks = ('nodeEnv' in o ? o.nodeEnv : process.env.NODE_ENV) !== 'production';
  const log = o.logger.child({ component: 'auth' });

  /**
   * Never throws: an email that cannot be built or sent is logged (without link, address or token) and the request
   * carries on, so sign-up and reset requests never fail with a 500 because of mail.
   */
  const sendAuthMail = async (
    to: string,
    request: Request | undefined,
    kind: LinkKind,
    build: () => MailTemplate,
  ): Promise<void> => {
    if (!o.mailer || isBootstrap()) return;
    try {
      const template = build();
      const locale = pickLocale(request?.headers.get('accept-language'));
      await o.mailer.send({ to, ...renderMail(locale, template) });
    } catch (err) {
      log.warn(mailFailure(kind, err), 'auth email not sent');
    }
  };

  return betterAuth({
    appName: 'Owlwire',
    logger: betterAuthLogger(o.logger),
    // The server never phones home.
    telemetry: { enabled: false },
    baseURL: o.env.baseURL,
    basePath: AUTH_BASE_PATH,
    secret: o.env.secret,
    trustedOrigins: [o.env.baseURL],
    database: authAdapter(o.db),
    rateLimit: {
      enabled: true,
      // Shared by every replica.
      storage: 'database',
      modelName: 'auth_rate_limit',
      window: AUTH_RATE_LIMIT.window,
      max: AUTH_RATE_LIMIT.max,
      customRules: { '/sign-in/email': { ...SIGN_IN_RATE_LIMIT } },
    },
    advanced: {
      // Explicit, so the origin, callback URL and CSRF checks never depend on NODE_ENV (the library turns the
      // origin check off when NODE_ENV=test).
      disableOriginCheck: false,
      disableCSRFCheck: false,
      cookiePrefix: AUTH_COOKIE_PREFIX,
      useSecureCookies: secureCookiesFor(o.env.baseURL),
      // Only the header our mount sets; forwarded headers sent by clients are never read here.
      ipAddress: { ipAddressHeaders: [AUTH_CLIENT_IP_HEADER] },
      database: { generateId: () => newId() },
    },
    user: {
      modelName: 'auth_user',
      additionalFields: {
        isInstanceAdmin: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    session: {
      modelName: 'auth_session',
      expiresIn: SESSION_EXPIRES_IN_SECONDS,
      updateAge: SESSION_UPDATE_AGE_SECONDS,
    },
    // Provider tokens are encrypted with the auth secret before they reach auth_account.
    account: { modelName: 'auth_account', encryptOAuthTokens: true },
    // Reset tokens and other verification identifiers are stored as hashes, so a leaked row cannot be replayed.
    verification: { modelName: 'auth_verification', storeIdentifier: 'hashed' },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      requireEmailVerification: emailEnabled,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
      ...(emailEnabled
        ? {
            sendResetPassword: async (
              {
                user,
                url,
                token,
              }: { user: { email: string; name: string }; url: string; token: string },
              request?: Request,
            ) =>
              sendAuthMail(user.email, request, 'reset_password', () => ({
                kind: 'reset_password',
                name: user.name,
                url: buildAuthLink(o.env.baseURL, allowHttpLinks, 'reset_password', token, url),
                expiresInSeconds: RESET_PASSWORD_TOKEN_EXPIRES_IN_SECONDS,
              })),
          }
        : {}),
    },
    ...(emailEnabled
      ? {
          emailVerification: {
            sendOnSignUp: true,
            autoSignInAfterVerification: true,
            expiresIn: EMAIL_VERIFICATION_EXPIRES_IN_SECONDS,
            sendVerificationEmail: async (
              {
                user,
                url,
                token,
              }: { user: { email: string; name: string }; url: string; token: string },
              request?: Request,
            ) =>
              sendAuthMail(user.email, request, 'verify_email', () => ({
                kind: 'verify_email',
                name: user.name,
                url: buildAuthLink(o.env.baseURL, allowHttpLinks, 'verify_email', token, url),
              })),
          },
        }
      : {}),
    databaseHooks: {
      user: {
        create: {
          before: async (user: { email: string } & Record<string, unknown>) => {
            const email = user.email.trim().toLowerCase();
            try {
              await o.hooks.beforeUserCreate(email);
            } catch (err) {
              if (err instanceof RegistrationDeniedError) {
                throw new APIError('FORBIDDEN', {
                  message: err.reason,
                  code: err.reason.toUpperCase(),
                });
              }
              throw err;
            }
            return { data: { ...user, email } };
          },
          after: async (user: { id: string; name: string; email: string }) => {
            try {
              await o.hooks.afterUserCreate({ id: user.id, name: user.name, email: user.email });
            } catch (err) {
              log.error(
                { err, userId: user.id },
                'post sign-up hook failed; /api/me will repair the personal workspace',
              );
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
