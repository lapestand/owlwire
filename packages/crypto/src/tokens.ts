import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const INSTALLATION_TOKEN_PREFIX = 'ow_inst_';
export const APP_KEY_PREFIX = 'ow_app_';
const TOKEN_BYTES = 32;
const TOKEN_BODY_LENGTH = 43; // ceil(256 / log2(62))
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const INSTALLATION_TOKEN_RE = /^ow_inst_[0-9A-Za-z]{43}$/;

export function base62(bytes: Uint8Array, length: number): string {
  const hex = Buffer.from(bytes).toString('hex');
  let n = hex.length > 0 ? BigInt(`0x${hex}`) : 0n;
  let out = '';
  while (n > 0n) {
    out = ALPHABET.charAt(Number(n % 62n)) + out;
    n /= 62n;
  }
  if (out.length > length) {
    throw new RangeError(`base62 value needs ${out.length} characters, more than ${length}`);
  }
  return out.padStart(length, '0');
}

export function generateToken(kind: 'inst' | 'app'): string {
  const prefix = kind === 'inst' ? INSTALLATION_TOKEN_PREFIX : APP_KEY_PREFIX;
  return prefix + base62(randomBytes(TOKEN_BYTES), TOKEN_BODY_LENGTH);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function tokenPrefix(token: string): string {
  return token.slice(0, 12);
}

/** Constant-time string comparison (length independent). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function verifyTokenHash(token: string, expectedHash: string): boolean {
  return safeEqual(hashToken(token), expectedHash);
}

export function isInstallationToken(s: string): boolean {
  return INSTALLATION_TOKEN_RE.test(s);
}
