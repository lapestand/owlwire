import { randomBytes } from 'node:crypto';
import { jsonBytes, open, seal } from './aead.js';
import { KEY_BYTES, type Kek, type KekRing } from './keys.js';

const WRAP_FORMAT = 0x01;
const DATA_FORMAT = 0x01;
const BOX_FORMAT = 0x02;

export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function wrapDek(kek: Kek, dek: Buffer): Buffer {
  const header = Buffer.alloc(3);
  header.writeUInt8(WRAP_FORMAT, 0);
  header.writeUInt16BE(kek.version, 1);
  return Buffer.concat([header, seal(kek.key, dek, header)]);
}

export function unwrapDek(ring: KekRing, wrapped: Buffer): Buffer {
  if (wrapped.length < 3 || wrapped[0] !== WRAP_FORMAT)
    throw new Error('unknown wrapped DEK format');
  const version = wrapped.readUInt16BE(1);
  const kek =
    ring.current.version === version
      ? ring.current
      : ring.previous?.version === version
        ? ring.previous
        : null;
  if (!kek) throw new Error(`no KEK available for KEK version ${version}`);
  return open(kek.key, wrapped.subarray(3), wrapped.subarray(0, 3));
}

export function encryptJson(dek: Buffer, value: unknown): Buffer {
  const aad = Buffer.of(DATA_FORMAT);
  const plaintext = jsonBytes(value);
  try {
    return Buffer.concat([aad, seal(dek, plaintext, aad)]);
  } finally {
    plaintext.fill(0);
  }
}

export function decryptJson<T>(dek: Buffer, blob: Buffer): T {
  if (blob.length < 1 || blob[0] !== DATA_FORMAT) throw new Error('unknown ciphertext format');
  const plaintext = open(dek, blob.subarray(1), blob.subarray(0, 1));
  try {
    return JSON.parse(plaintext.toString('utf8')) as T;
  } finally {
    plaintext.fill(0);
  }
}

/** @deprecated Yalnız eski `config_enc` (kek_v0, 0x02) okuması için; yeni sırlar sealJson + workspace DEK ile yazılır. */
export interface SecretBox {
  seal(value: unknown): Buffer;
  open<T>(blob: Buffer): T;
}

/**
 * Self-contained envelope (one DEK per secret); used for connections.config_enc before workspace DEKs.
 * @deprecated Yalnız eski `config_enc` (kek_v0, 0x02) okuması için; yeni sırlar sealJson + workspace DEK ile yazılır.
 */
export function createSecretBox(ring: KekRing): SecretBox {
  return {
    seal(value) {
      const dek = generateDek();
      try {
        const wrapped = wrapDek(ring.current, dek);
        const header = Buffer.alloc(3);
        header.writeUInt8(BOX_FORMAT, 0);
        header.writeUInt16BE(wrapped.length, 1);
        return Buffer.concat([header, wrapped, encryptJson(dek, value)]);
      } finally {
        dek.fill(0);
      }
    },
    open<T>(blob: Buffer): T {
      if (blob.length < 3 || blob[0] !== BOX_FORMAT) throw new Error('unknown secret box format');
      const len = blob.readUInt16BE(1);
      if (len < 3 || blob.length < 3 + len + 1) throw new Error('secret box is truncated');
      const wrapped = blob.subarray(3, 3 + len);
      const dek = unwrapDek(ring, wrapped);
      try {
        return decryptJson<T>(dek, blob.subarray(3 + len));
      } finally {
        dek.fill(0);
      }
    },
  };
}
