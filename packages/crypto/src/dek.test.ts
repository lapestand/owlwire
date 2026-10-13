import { describe, expect, it } from 'vitest';
import { DecryptError } from './aead.js';
import {
  rewrapWorkspaceDek,
  UnknownKekVersionError,
  unwrapWorkspaceDek,
  wrapWorkspaceDek,
} from './dek.js';
import { generateDek } from './envelope.js';
import { createKeyring, generateKek } from './keyring.js';

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
