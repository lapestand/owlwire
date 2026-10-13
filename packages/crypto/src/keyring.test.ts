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

describe('KEK version bounds', () => {
  it('generateKek requires an integer version between 1 and 65535', () => {
    for (const v of [0, -1, 1.5, 65536, Number.NaN]) {
      expect(() => generateKek(v)).toThrow(RangeError);
    }
    expect(generateKek(1).version).toBe(1);
    expect(generateKek(65535).version).toBe(65535);
  });

  it('createKeyring rejects current or previous KEKs with an out of range version', () => {
    const key = Buffer.alloc(32, 1);
    const other = Buffer.alloc(32, 2);
    expect(() => createKeyring({ version: 0, key })).toThrow(KeyringConfigError);
    expect(() => createKeyring({ version: 65536, key })).toThrow(KeyringConfigError);
    expect(() => createKeyring({ version: 2, key }, { version: 1.5, key: other })).toThrow(
      KeyringConfigError,
    );
  });
});
