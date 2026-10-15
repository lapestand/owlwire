import { enabledSocialProviders } from '../auth/social.js';
import type { Deps } from '../deps.js';
import { getRegistrationMode } from './registration.js';
import { countInstanceAdmins } from './users.js';

/**
 * Sign-in setup problems worth an operator's attention, logged once when `serve` starts. None of them stops the
 * server. `env` is the process environment (NODE_ENV, and the removed development variables that may linger in
 * an old .env). Messages name settings, never their values.
 */
export async function collectAuthStartupWarnings(
  deps: Pick<Deps, 'db' | 'authDb' | 'config' | 'mailer' | 'authEnv'>,
  env: Record<string, string | undefined>,
): Promise<string[]> {
  const warnings: string[] = [];
  const publicUrl = new URL(deps.authEnv.baseURL);
  if (!deps.mailer) {
    warnings.push(
      'SMTP is not configured (OWLWIRE_SMTP_URL): email verification, password reset and invitation emails are ' +
        'disabled; running in single-admin personal mode.',
    );
  }
  if (!deps.authEnv.publicUrlConfigured && enabledSocialProviders(deps.authEnv).length > 0) {
    warnings.push(
      `Social sign-in is enabled but OWLWIRE_PUBLIC_URL is not set; OAuth callbacks will use ${publicUrl.origin}.`,
    );
  }
  if (env.NODE_ENV === 'production' && publicUrl.protocol !== 'https:') {
    warnings.push(
      'OWLWIRE_PUBLIC_URL is not https in production: session cookies are not marked Secure, passkeys work only on ' +
        'localhost' +
        (deps.mailer
          ? ', and verification and password reset emails are not sent, so new users cannot verify their email.'
          : '.'),
    );
  }
  if (publicUrl.protocol === 'https:' && deps.config.trustedProxies.length === 0) {
    // The server itself speaks plain HTTP, so an https public URL means TLS ends at a proxy in front of it.
    warnings.push(
      'OWLWIRE_PUBLIC_URL is https but OWLWIRE_TRUSTED_PROXIES is empty: if a reverse proxy forwards requests, ' +
        'every client shares the proxy address for sign-in rate limiting. List the proxy address or range.',
    );
  }
  // Removed together with the development endpoints; the server no longer reads them.
  if (env.OWLWIRE_DEV_ADMIN_TOKEN) {
    warnings.push(
      'OWLWIRE_DEV_ADMIN_TOKEN is no longer used and grants nothing; remove it from your environment.',
    );
  }
  if (env.OWLWIRE_DEV_FAKE_ADAPTER) {
    warnings.push('OWLWIRE_DEV_FAKE_ADAPTER is no longer used; remove it from your environment.');
  }
  if ((await countInstanceAdmins(deps)) === 0) {
    const mode = await getRegistrationMode(deps);
    warnings.push(
      mode === 'closed'
        ? 'No instance admin exists and registration is closed: run `owlwire admin create --email <email>`.'
        : 'No instance admin exists: run `owlwire admin create --email <email>`.',
    );
  }
  return warnings;
}
