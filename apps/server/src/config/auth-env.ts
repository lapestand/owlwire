import { inspect } from 'node:util';
import { z } from 'zod';

/** Social sign-in providers Owlwire supports (the auth/social.ts setup). */
export type SocialProvider = 'discord' | 'google' | 'github';
/** OAuth client of one social sign-in provider. */
export interface SocialCredentials {
  clientId: string;
  clientSecret: string;
}
export interface AuthEnv {
  secret: string;
  baseURL: string;
  publicUrlConfigured: boolean;
  smtp: { url: string; from: string } | null;
  social: Record<SocialProvider, SocialCredentials | null>;
}

export class AuthEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthEnvError';
  }
}

const optional = z.string().min(1).optional();

function isHttpOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    return (
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      u.username === '' &&
      u.password === '' &&
      u.pathname === '/' &&
      u.search === '' &&
      u.hash === ''
    );
  } catch {
    return false;
  }
}

function isSmtpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'smtp:' || u.protocol === 'smtps:') && u.hostname !== '';
  } catch {
    return false;
  }
}

// Keep this a plain z.object literal with one OWLWIRE_* key per line: scripts/check-env.mjs reads the keys from it.
const authEnvSchema = z.object({
  OWLWIRE_AUTH_SECRET: z
    .string({ error: 'OWLWIRE_AUTH_SECRET is required' })
    .min(32, 'OWLWIRE_AUTH_SECRET must be at least 32 characters')
    .refine(
      (v) => v.length < 32 || new Set(v).size >= 8,
      'OWLWIRE_AUTH_SECRET is too repetitive, generate one with: openssl rand -base64 32',
    ),
  OWLWIRE_PUBLIC_URL: z
    .url('OWLWIRE_PUBLIC_URL must be a valid URL')
    .refine(
      isHttpOrigin,
      'OWLWIRE_PUBLIC_URL must be an http:// or https:// origin without credentials, path, query or fragment',
    )
    .optional(),
  OWLWIRE_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  OWLWIRE_SMTP_URL: z
    .string()
    .refine(isSmtpUrl, 'OWLWIRE_SMTP_URL must be an smtp:// or smtps:// URL with a host')
    .optional(),
  OWLWIRE_SMTP_FROM: optional,
  OWLWIRE_DISCORD_CLIENT_ID: optional,
  OWLWIRE_DISCORD_CLIENT_SECRET: optional,
  OWLWIRE_GOOGLE_CLIENT_ID: optional,
  OWLWIRE_GOOGLE_CLIENT_SECRET: optional,
  OWLWIRE_GITHUB_CLIENT_ID: optional,
  OWLWIRE_GITHUB_CLIENT_SECRET: optional,
});

type AuthEnvKey = Exclude<keyof z.infer<typeof authEnvSchema>, 'OWLWIRE_PORT'>;

const SOCIAL_KEYS: Array<{ provider: SocialProvider; id: AuthEnvKey; secret: AuthEnvKey }> = [
  { provider: 'discord', id: 'OWLWIRE_DISCORD_CLIENT_ID', secret: 'OWLWIRE_DISCORD_CLIENT_SECRET' },
  { provider: 'google', id: 'OWLWIRE_GOOGLE_CLIENT_ID', secret: 'OWLWIRE_GOOGLE_CLIENT_SECRET' },
  { provider: 'github', id: 'OWLWIRE_GITHUB_CLIENT_ID', secret: 'OWLWIRE_GITHUB_CLIENT_SECRET' },
];

/** Trimmed values; unset and blank entries (the `KEY=` lines of a fresh .env) are dropped. */
function clean(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    const trimmed = value?.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

/** Cross-field rules. They run even when a field is invalid so one pass reports every problem. */
function crossFieldProblems(input: Record<string, string>): string[] {
  const problems: string[] = [];
  if (input.OWLWIRE_SMTP_URL && !input.OWLWIRE_SMTP_FROM) {
    problems.push('OWLWIRE_SMTP_FROM is required when OWLWIRE_SMTP_URL is set');
  }
  for (const k of SOCIAL_KEYS) {
    if (Boolean(input[k.id]) !== Boolean(input[k.secret])) {
      problems.push(`${k.id} and ${k.secret} must be set together`);
    }
  }
  return problems;
}

const REDACTED = '[redacted]';

/** Hides the secret-bearing fields from JSON.stringify and util.inspect, so a logged config cannot leak them. */
function guard<T extends object>(target: T, redacted: () => unknown): T {
  const hidden = { enumerable: false, value: redacted };
  Object.defineProperty(target, 'toJSON', hidden);
  Object.defineProperty(target, inspect.custom, hidden);
  return target;
}

export function loadAuthEnv(source: Record<string, string | undefined>): AuthEnv {
  const input = clean(source);
  const parsed = authEnvSchema.safeParse(input);
  // Messages name the variable and never its value: secrets must not reach logs or error output.
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((i) => {
        const name = String(i.path[0] ?? '');
        return name === '' || i.message.includes(name) ? i.message : `${name}: ${i.message}`;
      });
  problems.push(...crossFieldProblems(input));
  if (!parsed.success || problems.length > 0) throw new AuthEnvError(problems.join('; '));

  const v = parsed.data;
  const social = {} as Record<SocialProvider, SocialCredentials | null>;
  for (const k of SOCIAL_KEYS) {
    const clientId = v[k.id];
    const clientSecret = v[k.secret];
    social[k.provider] =
      clientId && clientSecret
        ? guard({ clientId, clientSecret }, () => ({ clientId, clientSecret: REDACTED }))
        : null;
  }
  const smtp =
    v.OWLWIRE_SMTP_URL && v.OWLWIRE_SMTP_FROM
      ? guard({ url: v.OWLWIRE_SMTP_URL, from: v.OWLWIRE_SMTP_FROM }, () => ({
          url: REDACTED,
          from: v.OWLWIRE_SMTP_FROM,
        }))
      : null;
  const env: AuthEnv = {
    secret: v.OWLWIRE_AUTH_SECRET,
    baseURL: (v.OWLWIRE_PUBLIC_URL ?? `http://localhost:${v.OWLWIRE_PORT}`).replace(/\/+$/, ''),
    publicUrlConfigured: v.OWLWIRE_PUBLIC_URL !== undefined,
    smtp,
    social,
  };
  return guard(env, () => ({ ...env, secret: REDACTED, smtp, social }));
}
