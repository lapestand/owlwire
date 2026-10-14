import { describe, expect, it } from 'vitest';
import { parseEditionConfig } from './schema.js';

describe('parseEditionConfig registration default', () => {
  it('keeps the code default when there is no yaml', () => {
    expect(parseEditionConfig(undefined).registration).toBe('closed');
  });

  it('derives registration from the profile when the yaml omits it', () => {
    expect(parseEditionConfig({ profile: 'community' }).registration).toBe('invite');
    expect(parseEditionConfig({ profile: 'open' }).registration).toBe('open');
    expect(parseEditionConfig({ profile: 'personal' }).registration).toBe('closed');
  });

  it('keeps an explicit registration value', () => {
    expect(parseEditionConfig({ profile: 'community', registration: 'open' }).registration).toBe(
      'open',
    );
  });

  it('treats an empty registration key like an omitted one', () => {
    expect(parseEditionConfig({ profile: 'community', registration: null }).registration).toBe(
      'invite',
    );
    expect(parseEditionConfig({ profile: 'open', registration: undefined }).registration).toBe(
      'open',
    );
  });
});
