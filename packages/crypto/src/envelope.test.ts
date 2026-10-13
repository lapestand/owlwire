import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  createSecretBox,
  decryptJson,
  encryptJson,
  generateDek,
  unwrapDek,
  wrapDek,
} from './envelope.js';
import { type KekRing, parseKek } from './keys.js';

const kek1 = parseKek(randomBytes(32).toString('base64'), 1);
const kek2 = parseKek(randomBytes(32).toString('base64'), 2);
const ring1: KekRing = { current: kek1, previous: null };
const ring2: KekRing = { current: kek2, previous: kek1 };

describe('DEK wrapping', () => {
  it('round-trips a DEK and records the KEK version', () => {
    const dek = generateDek();
    const wrapped = wrapDek(kek1, dek);
    expect(wrapped[0]).toBe(1);
    expect(wrapped.readUInt16BE(1)).toBe(1);
    expect(unwrapDek(ring1, wrapped).equals(dek)).toBe(true);
  });

  it('unwraps with the previous KEK during rotation', () => {
    const dek = generateDek();
    expect(unwrapDek(ring2, wrapDek(kek1, dek)).equals(dek)).toBe(true);
  });

  it('fails for an unknown KEK version', () => {
    const wrapped = wrapDek(kek2, generateDek());
    expect(() => unwrapDek(ring1, wrapped)).toThrow(/KEK version 2/);
  });

  it('detects tampering', () => {
    const wrapped = wrapDek(kek1, generateDek());
    wrapped[wrapped.length - 1] = (wrapped[wrapped.length - 1] ?? 0) ^ 0xff;
    expect(() => unwrapDek(ring1, wrapped)).toThrow();
  });
});

describe('JSON encryption', () => {
  it('round-trips JSON values', () => {
    const dek = generateDek();
    const blob = encryptJson(dek, { botToken: '123:abc', n: [1, 2] });
    expect(blob.toString('utf8')).not.toContain('123:abc');
    expect(decryptJson(dek, blob)).toEqual({ botToken: '123:abc', n: [1, 2] });
  });

  it('uses a fresh IV per call', () => {
    const dek = generateDek();
    expect(encryptJson(dek, 'x').equals(encryptJson(dek, 'x'))).toBe(false);
  });

  it('rejects the wrong key and truncated blobs', () => {
    const blob = encryptJson(generateDek(), { a: 1 });
    expect(() => decryptJson(generateDek(), blob)).toThrow();
    expect(() => decryptJson(generateDek(), blob.subarray(0, 10))).toThrow(/too short/);
  });
});

describe('SecretBox', () => {
  it('seals with a per-secret DEK and opens after KEK rotation', () => {
    const blob = createSecretBox(ring1).seal({ botToken: 't' });
    expect(blob[0]).toBe(2);
    expect(createSecretBox(ring2).open<{ botToken: string }>(blob)).toEqual({ botToken: 't' });
  });

  it('refuses blobs it did not produce', () => {
    expect(() => createSecretBox(ring1).open(Buffer.from([9, 0, 0]))).toThrow(/format/);
  });
});
