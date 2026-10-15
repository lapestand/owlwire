import { describe, expect, it } from 'vitest';
import { loadAuthEnv } from '../config/auth-env.js';
import { buildSocialProviders, enabledSocialProviders, SOCIAL_PROVIDERS } from './social.js';

// Long and varied enough for the secret checks; a fixture, not a real secret.
const SECRET = 'fixture-secret-for-social-tests-0123';

describe('social providers', () => {
  it('supports Discord, Google and GitHub', () => {
    expect(SOCIAL_PROVIDERS).toEqual(['discord', 'google', 'github']);
  });

  it('enables only configured providers', () => {
    const env = loadAuthEnv({
      OWLWIRE_AUTH_SECRET: SECRET,
      OWLWIRE_GOOGLE_CLIENT_ID: 'g',
      OWLWIRE_GOOGLE_CLIENT_SECRET: 'gs',
      OWLWIRE_DISCORD_CLIENT_ID: 'd',
      OWLWIRE_DISCORD_CLIENT_SECRET: 'ds',
    });
    expect(buildSocialProviders(env)).toEqual({
      discord: { clientId: 'd', clientSecret: 'ds' },
      google: { clientId: 'g', clientSecret: 'gs', disableIdTokenSignIn: true },
    });
    expect(enabledSocialProviders(env)).toEqual(['discord', 'google']);
  });

  it('returns nothing when no provider is configured', () => {
    const env = loadAuthEnv({ OWLWIRE_AUTH_SECRET: SECRET });
    expect(buildSocialProviders(env)).toEqual({});
    expect(enabledSocialProviders(env)).toEqual([]);
  });
});
