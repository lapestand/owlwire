import type { AuthEnv, SocialCredentials, SocialProvider } from '../config/auth-env.js';

export const SOCIAL_PROVIDERS = ['discord', 'google', 'github'] as const;

type ProviderOptions = SocialCredentials & { disableIdTokenSignIn?: boolean };

/**
 * Better Auth's socialProviders option: only the providers whose client id and secret are configured. Google's
 * id-token sign-in (POST /sign-in/social with an idToken) is off: it skips state and PKCE and accepts any Google id
 * token for our client for an hour; the web app uses the redirect flow.
 */
export function buildSocialProviders(
  env: AuthEnv,
): Partial<Record<SocialProvider, ProviderOptions>> {
  const out: Partial<Record<SocialProvider, ProviderOptions>> = {};
  for (const provider of SOCIAL_PROVIDERS) {
    const creds = env.social[provider];
    if (!creds) continue;
    out[provider] = {
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      ...(provider === 'google' ? { disableIdTokenSignIn: true } : {}),
    };
  }
  return out;
}

export function enabledSocialProviders(env: AuthEnv): SocialProvider[] {
  return SOCIAL_PROVIDERS.filter((p) => env.social[p] !== null);
}
