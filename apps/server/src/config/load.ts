import { type EditionConfig, parseEditionConfig } from '@owlwire/core';
import { type Kek, type KekRing, parseKek, parsePreviousKek } from '@owlwire/crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

export const ROLES = ['all', 'api', 'worker'] as const;
export type Role = (typeof ROLES)[number];
export const DEFAULT_CONFIG_PATH = '/etc/owlwire/owlwire.yaml';

export interface ServerConfig {
  /** Uygulama rolü (owlwire_app, RLS'e tabi). */
  databaseUrl: string;
  /**
   * Sahip/migration rolü (owlwire). Yoksa databaseUrl kullanılır; o rol RLS'i aşabiliyorsa serve açılmaz
   * (Sözleşme §4; NODE_ENV=development yalnız uyarır).
   */
  migrationDatabaseUrl?: string;
  kek: KekRing;
  role: Role;
  port: number;
  publicUrl: string | null;
  configPath: string;
  logLevel: string;
  telegramBotToken: string | null;
  devAdminToken: string | null;
  devFakeAdapter: boolean;
  edition: EditionConfig;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const envSchema = z.object({
  OWLWIRE_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL'),
  OWLWIRE_MIGRATION_DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
    .optional(),
  OWLWIRE_KEK: z.string().min(1),
  OWLWIRE_KEK_VERSION: z.coerce.number().int().min(1).max(65535).default(1),
  OWLWIRE_KEK_PREVIOUS: z.string().optional(),
  OWLWIRE_ROLE: z.enum(ROLES).default('all'),
  OWLWIRE_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  OWLWIRE_PUBLIC_URL: z.string().url().optional(),
  OWLWIRE_CONFIG: z.string().optional(),
  OWLWIRE_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  OWLWIRE_TELEGRAM_BOT_TOKEN: z.string().optional(),
  OWLWIRE_DEV_ADMIN_TOKEN: z.string().min(16).optional(),
  OWLWIRE_DEV_FAKE_ADAPTER: z.enum(['0', '1']).default('0'),
});

/** Keeps OWLWIRE_* variables and drops empty values (compose writes `KEY=` for unset ones). */
function compactEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('OWLWIRE_') && value !== undefined && value.trim() !== '') {
      out[key] = value.trim();
    }
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function loadConfig(
  env: Record<string, string | undefined>,
  readTextFile: (path: string) => string | null,
): ServerConfig {
  const parsed = envSchema.safeParse(compactEnv(env));
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.map(String).join('.')}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid environment: ${details}`);
  }
  const e = parsed.data;

  let current: Kek;
  try {
    current = parseKek(e.OWLWIRE_KEK, e.OWLWIRE_KEK_VERSION);
  } catch (err) {
    throw new ConfigError(`OWLWIRE_KEK: ${message(err)}`);
  }
  let previous: Kek | null = null;
  if (e.OWLWIRE_KEK_PREVIOUS) {
    try {
      previous = parsePreviousKek(e.OWLWIRE_KEK_PREVIOUS);
    } catch (err) {
      throw new ConfigError(`OWLWIRE_KEK_PREVIOUS: ${message(err)}`);
    }
    if (previous.version === current.version) {
      throw new ConfigError('OWLWIRE_KEK_PREVIOUS: version must differ from OWLWIRE_KEK_VERSION');
    }
  }

  const configPath = e.OWLWIRE_CONFIG ?? DEFAULT_CONFIG_PATH;
  const text = readTextFile(configPath);
  if (text === null && e.OWLWIRE_CONFIG) {
    throw new ConfigError(`OWLWIRE_CONFIG points to a missing file: ${configPath}`);
  }
  let edition: EditionConfig;
  try {
    edition = parseEditionConfig(text === null ? undefined : parseYaml(text));
  } catch (err) {
    throw new ConfigError(`invalid ${configPath}: ${message(err)}`);
  }

  return {
    databaseUrl: e.OWLWIRE_DATABASE_URL,
    ...(e.OWLWIRE_MIGRATION_DATABASE_URL
      ? { migrationDatabaseUrl: e.OWLWIRE_MIGRATION_DATABASE_URL }
      : {}),
    kek: { current, previous },
    role: e.OWLWIRE_ROLE,
    port: e.OWLWIRE_PORT,
    publicUrl: e.OWLWIRE_PUBLIC_URL ?? null,
    configPath,
    logLevel: e.OWLWIRE_LOG_LEVEL,
    telegramBotToken: e.OWLWIRE_TELEGRAM_BOT_TOKEN ?? null,
    devAdminToken: e.OWLWIRE_DEV_ADMIN_TOKEN ?? null,
    devFakeAdapter: e.OWLWIRE_DEV_FAKE_ADAPTER === '1',
    edition,
  };
}
