import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createKeyring, generateKek, KeyringConfigError } from './keyring.js';
import { parseKek, parsePreviousKek } from './keys.js';

describe('createKeyring', () => {
  it('looks up current and previous KEKs by version', () => {
    const current = generateKek(2);
    const previous = generateKek(1);
    const k = createKeyring(current, previous);
    expect(k.current).toBe(current);
    expect(k.previous).toBe(previous);
    expect(k.byVersion(2)).toBe(current);
    expect(k.byVersion(1)).toBe(previous);
    expect(k.byVersion(3)).toBeUndefined();
  });

  it('defaults previous to null', () => {
    const k = createKeyring(generateKek(1));
    expect(k.previous).toBeNull();
    expect(k.byVersion(1)?.key.length).toBe(32);
  });

  it('accepts KEKs parsed by the P0 config loader (KekRing fields)', () => {
    const current = parseKek(randomBytes(32).toString('base64'), 2);
    const previous = parsePreviousKek(`1:${randomBytes(32).toString('base64')}`);
    const k = createKeyring(current, previous);
    expect(k.byVersion(1)).toBe(previous);
  });

  it('rejects a previous KEK with the same version', () => {
    expect(() => createKeyring(generateKek(1), generateKek(1))).toThrow(KeyringConfigError);
  });

  it('rejects a previous KEK equal to the current key', () => {
    const current = generateKek(2);
    expect(() => createKeyring(current, { version: 1, key: Buffer.from(current.key) })).toThrow(
      'equals OWLWIRE_KEK',
    );
  });
});
