import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sealJson } from './aead.js';
import {
  createSecretBox,
  decryptJson,
  encryptJson,
  generateDek,
  unwrapDek,
  wrapDek,
} from './envelope.js';
import { parseKek } from './keys.js';
import { base62 } from './tokens.js';

const kek = (version: number) => parseKek(randomBytes(32).toString('base64'), version);
const flip = (buf: Buffer, i: number): Buffer => {
  const out = Buffer.from(buf);
  out[i] = (out[i] ?? 0) ^ 0xff;
  return out;
};

describe('legacy envelope header tampering', () => {
  it('rejects a wrapped DEK whose KEK version, IV or tag was changed', () => {
    const ring = { current: kek(2), previous: kek(1) };
    const wrapped = wrapDek(ring.current, generateDek()); // [0x01][u16 version][iv12][tag16][ct]
    const relabelled = Buffer.from(wrapped);
    relabelled.writeUInt16BE(1, 1); // başlık v1 diyor; AAD artık eşleşmez
    expect(() => unwrapDek(ring, relabelled)).toThrow();
    expect(() => unwrapDek(ring, flip(wrapped, 3))).toThrow(); // IV
    expect(() => unwrapDek(ring, flip(wrapped, 3 + 12))).toThrow(); // tag
  });

  it('rejects JSON ciphertext whose format byte, IV or tag was changed', () => {
    const dek = generateDek();
    const blob = encryptJson(dek, { a: 1 }); // [0x01][iv12][tag16][ct]
    expect(() => decryptJson(dek, flip(blob, 0))).toThrow('unknown ciphertext format');
    expect(() => decryptJson(dek, flip(blob, 1))).toThrow();
    expect(() => decryptJson(dek, flip(blob, 13))).toThrow();
  });
});

describe('legacy SecretBox bounds', () => {
  const box = createSecretBox({ current: kek(1), previous: null });

  it('rejects truncated boxes and length fields that point past the end', () => {
    const blob = box.seal({ botToken: 'x' });
    expect(() => box.open(blob.subarray(0, 3))).toThrow('secret box is truncated');
    const huge = Buffer.from(blob);
    huge.writeUInt16BE(0xffff, 1);
    expect(() => box.open(huge)).toThrow('secret box is truncated');
    expect(() => box.open(blob.subarray(0, blob.length - 20))).toThrow();
  });

  it('rejects a box whose embedded wrapped DEK header was changed', () => {
    const blob = box.seal({ botToken: 'x' });
    expect(() => box.open(flip(blob, 3))).toThrow();
  });
});

describe('JSON serialisation guards', () => {
  it('encryptJson and sealJson reject undefined with a clear error', () => {
    const dek = generateDek();
    expect(() => encryptJson(dek, undefined)).toThrow('value is not JSON serializable');
    expect(() => sealJson(dek, undefined, 'x')).toThrow('value is not JSON serializable');
  });
});

describe('base62 length guard', () => {
  it('throws instead of returning a string longer than requested', () => {
    expect(() => base62(Buffer.alloc(33, 0xff), 43)).toThrow(RangeError);
    expect(base62(Buffer.alloc(32, 0xff), 43)).toHaveLength(43);
  });
});
