import { describe, expect, it } from 'vitest';
import { isProviderCallback } from './hooks.js';

describe('isProviderCallback', () => {
  it('matches only the OAuth redirect callback route', () => {
    expect(isProviderCallback('/callback/:id')).toBe(true);
    for (const path of [
      '/callback/:id/oauth-proxy',
      '/callback/:id/',
      '/callback/',
      '/callback/github',
      '/oauth2/callback/:providerId',
      '/sign-in/social',
      '/sign-up/email',
      null,
    ]) {
      expect(isProviderCallback(path)).toBe(false);
    }
  });
});
