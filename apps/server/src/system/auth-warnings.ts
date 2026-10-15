import { isIP } from 'node:net';
import { enabledSocialProviders } from '../auth/social.js';
import type { Deps } from '../deps.js';
import { getRegistrationMode } from './registration.js';
import { countInstanceAdmins } from './users.js';

/**
 * Whether mail to an `smtp://` URL may go out in clear text. nodemailer upgrades such a connection with STARTTLS only
 * when the server offers it, so an attacker on the path can strip the offer, unless the URL's query sets
 * `requireTLS=true`. `smtps://` is TLS from the first byte. Only the scheme and that one query flag are read.
 */
function smtpTlsOptional(url: string): boolean {
  const u = new URL(url);
  return u.protocol === 'smtp:' && u.searchParams.get('requireTLS')?.toLowerCase() !== 'true';
}

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
    // Without OWLWIRE_PUBLIC_URL the base URL falls back to an http address, so "not https" would mislead.
    const problem = deps.authEnv.publicUrlConfigured
      ? 'is not https in production'
      : 'is not set in production, so an http address is used';
    warnings.push(
      `OWLWIRE_PUBLIC_URL ${problem}: session cookies are not marked Secure, passkeys work only on localhost` +
        (deps.mailer
          ? ', and verification and password reset emails are not sent, so new users cannot verify their email.'
          : '.'),
    );
  }
  // WebAuthn takes the relying party id from this host and refuses IP addresses (only localhost is exempt).
  if (isIP(publicUrl.hostname.replace(/^\[|\]$/g, '')) !== 0) {
    warnings.push(
      'OWLWIRE_PUBLIC_URL uses an IP address as its host: passkeys need a domain name (localhost works for local ' +
        'testing), so passkey sign-up and sign-in will fail. Use a domain name.',
    );
  }
  if (
    env.NODE_ENV === 'production' &&
    deps.authEnv.smtp &&
    smtpTlsOptional(deps.authEnv.smtp.url)
  ) {
    warnings.push(
      'OWLWIRE_SMTP_URL is smtp:// without requireTLS in production: STARTTLS is optional, so an attacker on the ' +
        'network can downgrade the connection and read sign-in links and the SMTP password. Use smtps://, or add ' +
        '?requireTLS=true to the URL.',
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
