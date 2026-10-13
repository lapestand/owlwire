import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { KEY_BYTES } from './keys.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** AES-256-GCM; output = iv(12) | tag(16) | ciphertext */
export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, blob: Buffer, aad: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext too short');
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ct = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

const FORMAT_V1 = 0x01;
const NONCE_LEN = 12;
const TAG_LEN = 16;

export class DecryptError extends Error {
  constructor(message = 'decryption failed') {
    super(message);
    this.name = 'DecryptError';
  }
}

function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new RangeError(`key must be ${KEY_BYTES} bytes`);
}

/** P1a biçimi: 0x01 | nonce(12) | ciphertext | tag(16); AAD satıra bağlı bağlam dizesidir. */
export function sealBytes(key: Uint8Array, plaintext: Uint8Array, aad: string): Buffer {
  assertKey(key);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_V1]), nonce, body, cipher.getAuthTag()]);
}

export function openBytes(key: Uint8Array, sealed: Uint8Array, aad: string): Buffer {
  assertKey(key);
  const buf = Buffer.from(sealed);
  if (buf.length < 1 + NONCE_LEN + TAG_LEN || buf[0] !== FORMAT_V1) {
    throw new DecryptError('unsupported ciphertext format');
  }
  const nonce = buf.subarray(1, 1 + NONCE_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const body = buf.subarray(1 + NONCE_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_LEN });
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new DecryptError();
  }
}

/** JSON.stringify undefined/fonksiyon/symbol için undefined döndürür; Buffer.from'un anlaşılmaz TypeError'ı yerine net hata (P0 devri). */
export function jsonBytes(value: unknown): Buffer {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new TypeError('value is not JSON serializable (undefined, a function or a symbol)');
  }
  return Buffer.from(text, 'utf8');
}

export function sealJson(key: Uint8Array, value: unknown, aad: string): Buffer {
  return sealBytes(key, jsonBytes(value), aad);
}

export function openJson<T = unknown>(key: Uint8Array, sealed: Uint8Array, aad: string): T {
  return JSON.parse(openBytes(key, sealed, aad).toString('utf8')) as T;
}
