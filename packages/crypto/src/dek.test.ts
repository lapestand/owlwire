import { describe, expect, it } from 'vitest';
import { buildAad, DecryptError, sealBytes } from './aead.js';
import {
  rewrapWorkspaceDek,
  UnknownKekVersionError,
  unwrapWorkspaceDek,
  wrapWorkspaceDek,
} from './dek.js';
import { generateDek } from './envelope.js';
import { createKeyring, generateKek } from './keyring.js';
import { KEY_BYTES } from './keys.js';

const WS_A = '0192f0a0-0000-7000-8000-00000000000a';
const WS_B = '0192f0a0-0000-7000-8000-00000000000b';

describe('workspace dek', () => {
  it('wraps and unwraps with the keyring version', () => {
    const keyring = createKeyring(generateKek(1));
    const dek = generateDek();
    const wrapped = wrapWorkspaceDek(keyring.current, dek, WS_A);
    expect(wrapped.length).toBe(1 + 12 + 32 + 16);
    expect(unwrapWorkspaceDek(keyring, wrapped, 1, WS_A).equals(dek)).toBe(true);
  });

  it('refuses to unwrap a DEK copied to another workspace', () => {
    const keyring = createKeyring(generateKek(1));
    const wrapped = wrapWorkspaceDek(keyring.current, generateDek(), WS_A);
    expect(() => unwrapWorkspaceDek(keyring, wrapped, 1, WS_B)).toThrow(DecryptError);
  });

  it('throws UnknownKekVersionError for versions not in the keyring', () => {
    const keyring = createKeyring(generateKek(2));
    const old = generateKek(1);
    const wrapped = wrapWorkspaceDek(old, generateDek(), WS_A);
    expect(() => unwrapWorkspaceDek(keyring, wrapped, 1, WS_A)).toThrow(UnknownKekVersionError);
  });

  it('rewraps from previous to current keeping the same DEK', () => {
    const v1 = generateKek(1);
    const v2 = generateKek(2);
    const dek = generateDek();
    const wrappedV1 = wrapWorkspaceDek(v1, dek, WS_A);
    const next = rewrapWorkspaceDek(createKeyring(v2, v1), wrappedV1, 1, WS_A);
    expect(next.kekVersion).toBe(2);
    expect(unwrapWorkspaceDek(createKeyring(v2), next.wrapped, 2, WS_A).equals(dek)).toBe(true);
  });
});

describe('workspace dek hardening', () => {
  it('binds the wrap to the owlwire:dek purpose label and workspace id via buildAad', () => {
    const kek = generateKek(1);
    const dek = generateDek();
    const manual = sealBytes(kek.key, dek, buildAad('owlwire:dek', WS_A));
    expect(unwrapWorkspaceDek(createKeyring(kek), manual, 1, WS_A).equals(dek)).toBe(true);
  });

  it('refuses to wrap a DEK that is not KEY_BYTES long', () => {
    const kek = generateKek(1);
    expect(() => wrapWorkspaceDek(kek, Buffer.alloc(16), WS_A)).toThrow(RangeError);
    expect(() => wrapWorkspaceDek(kek, Buffer.alloc(KEY_BYTES + 1), WS_A)).toThrow(RangeError);
  });

  it('rejects an unwrapped payload with the wrong length', () => {
    const kek = generateKek(1);
    const short = sealBytes(kek.key, Buffer.alloc(16, 7), buildAad('owlwire:dek', WS_A));
    expect(() => unwrapWorkspaceDek(createKeyring(kek), short, 1, WS_A)).toThrow(DecryptError);
  });

  it('rejects a tampered wrapped DEK', () => {
    const keyring = createKeyring(generateKek(1));
    const wrapped = wrapWorkspaceDek(keyring.current, generateDek(), WS_A);
    wrapped[20] = (wrapped[20] ?? 0) ^ 0xff;
    expect(() => unwrapWorkspaceDek(keyring, wrapped, 1, WS_A)).toThrow(DecryptError);
  });

  it('rewrap fails for an unknown fromVersion and for a mismatched workspace', () => {
    const v1 = generateKek(1);
    const v2 = generateKek(2);
    const wrappedV1 = wrapWorkspaceDek(v1, generateDek(), WS_A);
    const keyring = createKeyring(v2, v1);
    expect(() => rewrapWorkspaceDek(keyring, wrappedV1, 3, WS_A)).toThrow(UnknownKekVersionError);
    expect(() => rewrapWorkspaceDek(keyring, wrappedV1, 1, WS_B)).toThrow(DecryptError);
  });
});
