import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DecryptError, openBytes, openJson, sealBytes, sealJson } from './aead.js';
import { KEY_BYTES } from './keys.js';

const key = () => randomBytes(KEY_BYTES);

describe('aead v1 (sealBytes/openBytes)', () => {
  it('round-trips bytes with the same key and aad', () => {
    const k = key();
    const sealed = sealBytes(k, Buffer.from('hello'), 'aad-1');
    expect(openBytes(k, sealed, 'aad-1').toString('utf8')).toBe('hello');
  });

  it('produces a different ciphertext each time (random nonce)', () => {
    const k = key();
    const a = sealBytes(k, Buffer.from('same'), 'x');
    const b = sealBytes(k, Buffer.from('same'), 'x');
    expect(a.equals(b)).toBe(false);
  });

  it('starts with format byte 0x01 and has nonce + tag overhead', () => {
    const sealed = sealBytes(key(), Buffer.from('abc'), 'x');
    expect(sealed[0]).toBe(0x01);
    expect(sealed.length).toBe(1 + 12 + 3 + 16);
  });

  it('rejects a different aad', () => {
    const k = key();
    const sealed = sealBytes(k, Buffer.from('secret'), 'connection-a');
    expect(() => openBytes(k, sealed, 'connection-b')).toThrow(DecryptError);
  });

  it('rejects a different key', () => {
    const sealed = sealBytes(key(), Buffer.from('secret'), 'x');
    expect(() => openBytes(key(), sealed, 'x')).toThrow(DecryptError);
  });

  it('rejects tampered ciphertext', () => {
    const k = key();
    const sealed = sealBytes(k, Buffer.from('secret'), 'x');
    sealed[14] = (sealed[14] ?? 0) ^ 0xff;
    expect(() => openBytes(k, sealed, 'x')).toThrow(DecryptError);
  });

  it('rejects unknown format byte and short input', () => {
    const k = key();
    const sealed = sealBytes(k, Buffer.from('secret'), 'x');
    sealed[0] = 0x02;
    expect(() => openBytes(k, sealed, 'x')).toThrow(DecryptError);
    expect(() => openBytes(k, Buffer.from([1, 2, 3]), 'x')).toThrow(DecryptError);
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => sealBytes(randomBytes(16), Buffer.from('a'), 'x')).toThrow(RangeError);
  });

  it('round-trips json', () => {
    const k = key();
    const value = { botToken: '123:abc', nested: { n: 1 } };
    expect(openJson(k, sealJson(k, value, 'x'), 'x')).toEqual(value);
  });
});
