import type { AuthEnv, SocialCredentials, SocialProvider } from '../config/auth-env.js';

export const SOCIAL_PROVIDERS = ['discord', 'google', 'github'] as const;

/** Better Auth's socialProviders option: only the providers whose client id and secret are configured. */
export function buildSocialProviders(
  env: AuthEnv,
): Partial<Record<SocialProvider, SocialCredentials>> {
  const out: Partial<Record<SocialProvider, SocialCredentials>> = {};
  for (const provider of SOCIAL_PROVIDERS) {
    const creds = env.social[provider];
    if (creds) out[provider] = { clientId: creds.clientId, clientSecret: creds.clientSecret };
  }
  return out;
}

export function enabledSocialProviders(env: AuthEnv): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((p) => env.social[p] !== null);
}
