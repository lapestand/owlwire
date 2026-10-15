import { type EditionConfig, parseEditionConfig } from '@owlwire/core';
import { type Kek, type KekRing, parseKek, parsePreviousKek } from '@owlwire/crypto';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { parseTrustedProxies, TrustedProxyError } from '../http/client-ip.js';
import { type AuthEnv, AuthEnvError, loadAuthEnv } from './auth-env.js';

export const ROLES = ['all', 'api', 'worker'] as const;
export type Role = (typeof ROLES)[number];
const DEFAULT_CONFIG_PATH = '/etc/owlwire/owlwire.yaml';

export interface ServerConfig {
  /** Uygulama rolü (owlwire_app, RLS'e tabi). */
  databaseUrl: string;
  /**
   * Sahip/migration rolü (owlwire). Yoksa databaseUrl kullanılır; o rol RLS'i aşabiliyorsa serve açılmaz.
   */
  migrationDatabaseUrl?: string;
  /**
   * The auth role (owlwire_auth): the only connection that can read sessions, credentials and tokens; the auth
   * library alone uses it. Without it the auth library falls back to databaseUrl, and serve refuses to start (unless
   * OWLWIRE_ALLOW_INSECURE_DB_ROLE allows it) because the application role cannot, and must not, reach those tables.
   */
  authDatabaseUrl?: string;
  /**
   * OWLWIRE_ALLOW_INSECURE_DB_ROLE=true: yerel geliştirme için, RLS'e tabi olmayan uygulama bağlantısıyla (tek rol,
   * süper kullanıcı) serve'ün uyarıyla açılmasına izin verir. NODE_ENV=production'da yok sayılır.
   */
  allowInsecureDbRole: boolean;
  kek: KekRing;
  role: Role;
  port: number;
  publicUrl: string | null;
  configPath: string;
  logLevel: string;
  telegramBotToken: string | null;
  edition: EditionConfig;
  /**
   * Proxy addresses and CIDR ranges (OWLWIRE_TRUSTED_PROXIES) whose X-Forwarded-For is believed when they are the
   * TCP peer. Empty: forwarded headers are never trusted and the socket address is the client.
   */
  trustedProxies: readonly string[];
  /** Sign-in settings (secret, public URL, SMTP, social providers); serialising it hides the secrets. */
  authEnv: AuthEnv;
  /**
   * Whether emailed links (verification, password reset, invitations) may use an http public URL: everywhere but
   * NODE_ENV=production, so local development works without TLS. Read once here; nothing else reads NODE_ENV for it.
   */
  allowHttpLinks: boolean;
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
  OWLWIRE_AUTH_DATABASE_URL: z
    .string()
    .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
    .optional(),
  OWLWIRE_ALLOW_INSECURE_DB_ROLE: z.enum(['true', 'false']).default('false'),
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
  OWLWIRE_TRUSTED_PROXIES: z.string().optional(),
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

  let trustedProxies: string[];
  try {
    trustedProxies = parseTrustedProxies(e.OWLWIRE_TRUSTED_PROXIES);
  } catch (err) {
    if (err instanceof TrustedProxyError) throw new ConfigError(err.message);
    throw err;
  }

  let authEnv: AuthEnv;
  try {
    authEnv = loadAuthEnv(env);
  } catch (err) {
    if (err instanceof AuthEnvError) throw new ConfigError(err.message);
    throw err;
  }

  return {
    databaseUrl: e.OWLWIRE_DATABASE_URL,
    ...(e.OWLWIRE_MIGRATION_DATABASE_URL
      ? { migrationDatabaseUrl: e.OWLWIRE_MIGRATION_DATABASE_URL }
      : {}),
    ...(e.OWLWIRE_AUTH_DATABASE_URL ? { authDatabaseUrl: e.OWLWIRE_AUTH_DATABASE_URL } : {}),
    allowInsecureDbRole: e.OWLWIRE_ALLOW_INSECURE_DB_ROLE === 'true',
    kek: { current, previous },
    role: e.OWLWIRE_ROLE,
    port: e.OWLWIRE_PORT,
    publicUrl: e.OWLWIRE_PUBLIC_URL ?? null,
    configPath,
    logLevel: e.OWLWIRE_LOG_LEVEL,
    telegramBotToken: e.OWLWIRE_TELEGRAM_BOT_TOKEN ?? null,
    edition,
    trustedProxies,
    authEnv,
    allowHttpLinks: env.NODE_ENV !== 'production',
  };
}
