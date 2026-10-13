import { describe, expect, it } from 'vitest';
import { DEFAULT_EDITION_CONFIG, parseEditionConfig } from './schema.js';

describe('parseEditionConfig', () => {
  it('returns defaults for an empty file', () => {
    expect(parseEditionConfig(undefined)).toEqual(DEFAULT_EDITION_CONFIG);
    expect(parseEditionConfig(null)).toEqual(DEFAULT_EDITION_CONFIG);
    expect(DEFAULT_EDITION_CONFIG.profile).toBe('personal');
    expect(DEFAULT_EDITION_CONFIG.registration).toBe('closed');
    expect(DEFAULT_EDITION_CONFIG.pacing.defaults.whatsapp).toBe('safe');
    expect(DEFAULT_EDITION_CONFIG.retention).toEqual({ contentDays: 30, metadataDays: 180 });
    expect(DEFAULT_EDITION_CONFIG.ingest.ratePerMinutePerToken).toBe(600);
  });

  it('deep merges partial overrides with defaults', () => {
    const cfg = parseEditionConfig({
      profile: 'community',
      platforms: { telegram: { enabled: true } },
      quotas: { workspaceDailyEvents: 1000 },
    });
    expect(cfg.profile).toBe('community');
    expect(cfg.platforms.telegram.enabled).toBe(true);
    expect(cfg.platforms.discord).toEqual({ enabled: false, allowWebhooks: true });
    expect(cfg.quotas).toEqual({
      enabled: false,
      workspaceDailyEvents: 1000,
      workspaceDailyDeliveries: null,
    });
  });

  it('rejects unknown top-level keys and invalid values', () => {
    expect(() => parseEditionConfig({ profil: 'personal' })).toThrow();
    expect(() => parseEditionConfig({ profile: 'hosted' })).toThrow();
    expect(() => parseEditionConfig({ retention: { contentDays: 0 } })).toThrow();
    expect(() => parseEditionConfig({ ingest: { ratePerMinutePerToken: 1.5 } })).toThrow();
  });

  it('accepts a non-positive ingest rate that disables the limit', () => {
    const off = parseEditionConfig({ ingest: { ratePerMinutePerToken: 0 } });
    expect(off.ingest.ratePerMinutePerToken).toBe(0);
    const negative = parseEditionConfig({ ingest: { ratePerMinutePerToken: -1 } });
    expect(negative.ingest.ratePerMinutePerToken).toBe(-1);
  });

  it('rejects a non-mapping document', () => {
    expect(() => parseEditionConfig('profile: personal')).toThrow(/mapping/);
    expect(() => parseEditionConfig([1, 2])).toThrow(/mapping/);
  });
});
