import { z } from 'zod';

/** @public Consumed by the sign-in provider setup. */
export type SocialProvider = 'discord' | 'google' | 'github';
/** @public Consumed by the sign-in provider setup. */
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

const SOCIAL_KEYS: Array<{ provider: SocialProvider; id: string; secret: string }> = [
  { provider: 'discord', id: 'OWLWIRE_DISCORD_CLIENT_ID', secret: 'OWLWIRE_DISCORD_CLIENT_SECRET' },
  { provider: 'google', id: 'OWLWIRE_GOOGLE_CLIENT_ID', secret: 'OWLWIRE_GOOGLE_CLIENT_SECRET' },
  { provider: 'github', id: 'OWLWIRE_GITHUB_CLIENT_ID', secret: 'OWLWIRE_GITHUB_CLIENT_SECRET' },
];

const optional = z.string().trim().min(1).optional();

const authEnvSchema = z.object({
  OWLWIRE_AUTH_SECRET: z
    .string({ error: 'OWLWIRE_AUTH_SECRET is required' })
    .min(32, 'OWLWIRE_AUTH_SECRET must be at least 32 characters'),
  OWLWIRE_PUBLIC_URL: z.string().url().optional(),
  OWLWIRE_PORT: z.coerce.number().int().positive().default(8080),
  OWLWIRE_SMTP_URL: z
    .string()
    .regex(/^smtps?:\/\//, 'OWLWIRE_SMTP_URL must start with smtp:// or smtps://')
    .optional(),
  OWLWIRE_SMTP_FROM: optional,
  OWLWIRE_DISCORD_CLIENT_ID: optional,
  OWLWIRE_DISCORD_CLIENT_SECRET: optional,
  OWLWIRE_GOOGLE_CLIENT_ID: optional,
  OWLWIRE_GOOGLE_CLIENT_SECRET: optional,
  OWLWIRE_GITHUB_CLIENT_ID: optional,
  OWLWIRE_GITHUB_CLIENT_SECRET: optional,
});

const RawAuthEnv = authEnvSchema.superRefine((v, ctx) => {
  if (v.OWLWIRE_SMTP_URL && !v.OWLWIRE_SMTP_FROM) {
    ctx.addIssue({
      code: 'custom',
      path: ['OWLWIRE_SMTP_FROM'],
      message: 'OWLWIRE_SMTP_FROM is required when OWLWIRE_SMTP_URL is set',
    });
  }
  const record = v as Record<string, unknown>;
  for (const k of SOCIAL_KEYS) {
    if (Boolean(record[k.id]) !== Boolean(record[k.secret])) {
      ctx.addIssue({
        code: 'custom',
        path: [k.secret],
        message: `${k.id} and ${k.secret} must be set together`,
      });
    }
  }
});

function dropEmpty(source: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') out[key] = value;
  }
  return out;
}

export function loadAuthEnv(source: Record<string, string | undefined>): AuthEnv {
  const parsed = RawAuthEnv.safeParse(dropEmpty(source));
  if (!parsed.success) {
    // Messages name the variable and never its value: secrets must not reach logs or error output.
    const messages = parsed.error.issues.map((i) => {
      const name = String(i.path[0] ?? '');
      return name === '' || i.message.includes(name) ? i.message : `${name}: ${i.message}`;
    });
    throw new AuthEnvError(messages.join('; '));
  }
  const v = parsed.data;
  const record = v as Record<string, unknown>;
  const social = {} as Record<SocialProvider, SocialCredentials | null>;
  for (const k of SOCIAL_KEYS) {
    const clientId = record[k.id] as string | undefined;
    const clientSecret = record[k.secret] as string | undefined;
    social[k.provider] = clientId && clientSecret ? { clientId, clientSecret } : null;
  }
  return {
    secret: v.OWLWIRE_AUTH_SECRET,
    baseURL: (v.OWLWIRE_PUBLIC_URL ?? `http://localhost:${v.OWLWIRE_PORT}`).replace(/\/+$/, ''),
    publicUrlConfigured: v.OWLWIRE_PUBLIC_URL !== undefined,
    smtp:
      v.OWLWIRE_SMTP_URL && v.OWLWIRE_SMTP_FROM
        ? { url: v.OWLWIRE_SMTP_URL, from: v.OWLWIRE_SMTP_FROM }
        : null,
    social,
  };
}
