import { z } from 'zod';

export const PROFILES = ['personal', 'community', 'open'] as const;
export const REGISTRATION_MODES = ['closed', 'invite', 'open'] as const;

/** Registration mode a profile implies when the config does not name one. */
export const PROFILE_REGISTRATION_DEFAULTS: Record<
  (typeof PROFILES)[number],
  (typeof REGISTRATION_MODES)[number]
> = {
  personal: 'closed',
  community: 'invite',
  open: 'open',
};
// Hız ön ayarları tanımlandığında z.enum(PACING_PRESET_NAMES) ile değiştirilecek
const pacingPreset = z.enum(['safe', 'normal', 'fast', 'off']);

export const editionConfigSchema = z
  .object({
    profile: z.enum(PROFILES),
    registration: z.enum(REGISTRATION_MODES),
    publicApps: z.object({ requireApproval: z.boolean() }),
    platforms: z.object({
      telegram: z.object({ enabled: z.boolean() }),
      discord: z.object({ enabled: z.boolean(), allowWebhooks: z.boolean() }),
      whatsapp: z.object({ enabled: z.boolean(), experimentalAcknowledged: z.boolean() }),
      webhook: z.object({ enabled: z.boolean() }),
    }),
    pacing: z.object({
      defaults: z.object({
        whatsapp: pacingPreset,
        telegram: pacingPreset,
        discord: pacingPreset,
        webhook: pacingPreset,
      }),
      allowWorkspaceOverride: z.boolean(),
    }),
    quotas: z.object({
      enabled: z.boolean(),
      workspaceDailyEvents: z.number().int().positive().nullable(),
      workspaceDailyDeliveries: z.number().int().positive().nullable(),
    }),
    retention: z.object({
      contentDays: z.number().int().positive(),
      metadataDays: z.number().int().positive(),
    }),
    // <= 0 limiti kapatır (limit henüz uygulanmıyor)
    ingest: z.object({ ratePerMinutePerToken: z.number().int() }),
  })
  .strict();

export type EditionConfig = z.infer<typeof editionConfigSchema>;

export const DEFAULT_EDITION_CONFIG: EditionConfig = {
  profile: 'personal',
  registration: 'closed',
  publicApps: { requireApproval: true },
  platforms: {
    telegram: { enabled: false },
    discord: { enabled: false, allowWebhooks: true },
    whatsapp: { enabled: false, experimentalAcknowledged: false },
    webhook: { enabled: true },
  },
  pacing: {
    defaults: { whatsapp: 'safe', telegram: 'off', discord: 'off', webhook: 'off' },
    allowWorkspaceOverride: true,
  },
  quotas: { enabled: false, workspaceDailyEvents: null, workspaceDailyDeliveries: null },
  retention: { contentDays: 30, metadataDays: 180 },
  ingest: { ratePerMinutePerToken: 600 },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = key in base ? deepMerge(base[key], value) : value;
  }
  return out;
}

/** Parses the YAML-decoded edition config; missing keys fall back to DEFAULT_EDITION_CONFIG,
 *  a missing `registration` to the default of the effective profile. */
export function parseEditionConfig(raw: unknown): EditionConfig {
  if (raw === undefined || raw === null) return editionConfigSchema.parse(DEFAULT_EDITION_CONFIG);
  if (!isPlainObject(raw)) throw new Error('edition config must be a mapping (YAML object)');
  const merged = deepMerge(DEFAULT_EDITION_CONFIG, raw) as Record<string, unknown>;
  if (raw.registration === undefined || raw.registration === null) {
    const profile = (PROFILES as readonly unknown[]).includes(merged.profile)
      ? (merged.profile as (typeof PROFILES)[number])
      : DEFAULT_EDITION_CONFIG.profile;
    merged.registration = PROFILE_REGISTRATION_DEFAULTS[profile];
  }
  return editionConfigSchema.parse(merged);
}
