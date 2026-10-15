import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { TWO_FACTOR_COOKIE } from './second-factor-gate.js';

/**
 * The two-factor plugin's TOTP settings (its defaults, which auth.ts does not change): RFC 6238 with SHA-1, 6 digits,
 * 30-second steps, and one step either side of the current one accepted.
 */
const PERIOD_SECONDS = 30;
const DIGITS = 6;
const WINDOW = 1;
const CODE_PATTERN = /^\d{6}$/;
const USED_STEP_PREFIX = 'totp-used:';

function hotp(key: Buffer, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(message).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS).toString().padStart(DIGITS, '0');
}

/** The time step whose code `code` is, among the steps the plugin accepts at `nowMs`; null when none. */
function matchedStep(secret: string, code: string, nowMs: number): number | null {
  // The plugin uses the decrypted secret's UTF-8 bytes as the HMAC key.
  const key = Buffer.from(secret, 'utf8');
  const current = Math.floor(nowMs / 1000 / PERIOD_SECONDS);
  let found: number | null = null;
  for (let step = current - WINDOW; step <= current + WINDOW; step++) {
    const equal = timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code));
    if (equal && found === null) found = step;
  }
  return found;
}

/**
 * The primary key of the record that a user's code for `step` was accepted. Derived from the user and the step, so
 * two requests with the same code insert the same key and the database lets only the first one in.
 */
function usedStepId(authSecret: string, userId: string, step: number): string {
  const mac = createHmac('sha256', authSecret)
    .update(`${USED_STEP_PREFIX}${userId}:${step}`)
    .digest();
  const bytes = mac.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80; // UUID version 8 (custom)
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 9562 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Makes every TOTP code single use, which the two-factor plugin does not do on its own (a code would otherwise work
 * again for as long as its step is accepted, about 90 seconds).
 *
 * Before /two-factor/verify-totp runs, the hook finds the user the way the plugin does: the session, or else the
 * pending sign-in behind the signed `two_factor` cookie (issued after a password sign-in, or by the social
 * second-factor gate). It checks the code against the user's secret itself; a wrong code is left to the plugin, which
 * counts the failure. A right code is recorded in auth_verification under a key derived from the user and the
 * code's time step, and only the request whose insert succeeds goes on; any later or concurrent request with a code
 * for that step is refused with the plugin's own `401 INVALID_CODE`, before a session is issued. The record expires
 * when the step stops being accepted.
 */
export function totpSingleUse(): BetterAuthPlugin {
  return {
    id: 'owlwire-totp-single-use',
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === '/two-factor/verify-totp',
          handler: createAuthMiddleware(async (ctx) => {
            const code = (ctx.body as { code?: unknown } | undefined)?.code;
            if (typeof code !== 'string' || !CODE_PATTERN.test(code)) return;

            const session = await getSessionFromCtx(ctx);
            let userId = session?.user.id ?? null;
            if (!userId) {
              const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
              const challenge = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
              if (!challenge) return;
              userId =
                (await ctx.context.internalAdapter.findVerificationValue(challenge))?.value ?? null;
            }
            if (!userId) return;

            const row = await ctx.context.adapter.findOne<{ secret: string }>({
              model: 'twoFactor',
              where: [{ field: 'userId', value: userId }],
            });
            if (!row) return;
            const secret = await symmetricDecrypt({
              key: ctx.context.secretConfig,
              data: row.secret,
            });
            // The plugin's own clock: it checks the code against Date.now(), so this check must too.
            const step = matchedStep(secret, code, Date.now());
            if (step === null) return;

            const id = usedStepId(ctx.context.secret, userId, step);
            const now = new Date();
            try {
              await ctx.context.adapter.create({
                model: 'verification',
                data: {
                  id,
                  identifier: `${USED_STEP_PREFIX}${userId}`,
                  value: String(step),
                  expiresAt: new Date((step + WINDOW + 1) * PERIOD_SECONDS * 1000),
                  createdAt: now,
                  updatedAt: now,
                },
                forceAllowId: true,
              });
            } catch (error) {
              const taken = await ctx.context.adapter.findOne({
                model: 'verification',
                where: [{ field: 'id', value: id }],
              });
              if (!taken) throw error;
              throw new APIError('UNAUTHORIZED', { code: 'INVALID_CODE', message: 'Invalid code' });
            }
          }),
        },
      ],
    },
  };
}
