import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const value = ALPHABET.indexOf(ch);
    if (value < 0) throw new Error(`invalid base32 character: ${ch}`);
    bits += value.toString(2).padStart(5, '0');
  }
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8)
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits) for tests. */
export function totp(secretBase32: string, at: Date): string {
  const counter = Math.floor(at.getTime() / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secretBase32)).update(message).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/**
 * The code of the next 30 s step. The server accepts it now (one step either side), and it is never the code of the
 * current step, which a code accepted earlier in the same test may have used: a step's code is accepted once.
 */
export function nextTotp(secretBase32: string): string {
  return totp(secretBase32, new Date(Date.now() + 30_000));
}
