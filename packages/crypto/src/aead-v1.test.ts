import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildAad, DecryptError, openBytes, openJson, sealBytes, sealJson } from './aead.js';
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

describe('aead v1 format binding and tampering', () => {
  const flip = (buf: Buffer, i: number): Buffer => {
    const out = Buffer.from(buf);
    const at = i < 0 ? out.length + i : i;
    out[at] = (out[at] ?? 0) ^ 0xff;
    return out;
  };

  it('authenticates the format byte: a blob sealed without it in the AAD does not open', () => {
    const k = key();
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', k, nonce, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('x', 'utf8')); // AAD without the 0x01 format prefix
    const body = Buffer.concat([cipher.update(Buffer.from('secret')), cipher.final()]);
    const forged = Buffer.concat([Buffer.of(0x01), nonce, body, cipher.getAuthTag()]);
    expect(() => openBytes(k, forged, 'x')).toThrow(DecryptError);
  });

  it('rejects a flipped nonce byte, a flipped last tag byte, a truncated tag and a trailing byte', () => {
    const k = key();
    const sealed = sealBytes(k, Buffer.from('secret'), 'x');
    expect(() => openBytes(k, flip(sealed, 1), 'x')).toThrow(DecryptError);
    expect(() => openBytes(k, flip(sealed, -1), 'x')).toThrow(DecryptError);
    expect(() => openBytes(k, sealed.subarray(0, -1), 'x')).toThrow(DecryptError);
    expect(() => openBytes(k, Buffer.concat([sealed, Buffer.of(0)]), 'x')).toThrow(DecryptError);
  });

  it('round-trips an empty plaintext at the exact 29 byte minimum', () => {
    const k = key();
    const sealed = sealBytes(k, Buffer.alloc(0), 'x');
    expect(sealed.length).toBe(29);
    expect(openBytes(k, sealed, 'x').length).toBe(0);
    expect(() => openBytes(k, sealed.subarray(0, 28), 'x')).toThrow(DecryptError);
  });

  it('does not leak plaintext or key bytes in DecryptError messages', () => {
    const k = key();
    const plaintext = 'very-secret-plaintext';
    const sealed = sealBytes(k, Buffer.from(plaintext), 'x');
    let message = '';
    try {
      openBytes(k, sealed, 'y');
    } catch (err) {
      expect(err).toBeInstanceOf(DecryptError);
      message = (err as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain(plaintext);
    expect(message).not.toContain(k.toString('base64'));
    expect(message).not.toContain(k.toString('hex'));
  });
});

describe('buildAad', () => {
  it('encodes parts unambiguously', () => {
    expect(buildAad('a:b', 'c')).not.toBe(buildAad('a', 'b:c'));
    expect(buildAad('a', 'b')).not.toBe(buildAad('a,b'));
    expect(buildAad('a"', 'b')).not.toBe(buildAad('a', '"b'));
  });

  it('is deterministic and keeps the owlwire purpose label readable', () => {
    expect(buildAad('owlwire:dek', 'ws-1')).toBe(buildAad('owlwire:dek', 'ws-1'));
    expect(buildAad('owlwire:dek', 'ws-1')).toBe('["owlwire:dek","ws-1"]');
  });

  it('requires at least one part', () => {
    expect(() => buildAad()).toThrow(RangeError);
  });
});
