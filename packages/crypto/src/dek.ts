import { DecryptError, openBytes, sealBytes } from './aead.js';
import type { Keyring } from './keyring.js';
import { KEY_BYTES, type Kek } from './keys.js';

export class UnknownKekVersionError extends Error {
  constructor(readonly kekVersion: number) {
    super(
      `no KEK with version ${kekVersion} in keyring; set OWLWIRE_KEK_PREVIOUS="${kekVersion}:<base64>"`,
    );
    this.name = 'UnknownKekVersionError';
  }
}

const dekAad = (workspaceId: string): string => `owlwire:dek:${workspaceId}`;

/** Workspace DEK'ini KEK ile sarar; KEK sürümü workspace_keys.kek_version kolonunda tutulur. */
export function wrapWorkspaceDek(kek: Kek, dek: Uint8Array, workspaceId: string): Buffer {
  return sealBytes(kek.key, dek, dekAad(workspaceId));
}

export function unwrapWorkspaceDek(
  keyring: Keyring,
  wrapped: Uint8Array,
  kekVersion: number,
  workspaceId: string,
): Buffer {
  const kek = keyring.byVersion(kekVersion);
  if (!kek) throw new UnknownKekVersionError(kekVersion);
  const dek = openBytes(kek.key, wrapped, dekAad(workspaceId));
  if (dek.length !== KEY_BYTES) throw new DecryptError('unwrapped DEK has wrong length');
  return dek;
}

export function rewrapWorkspaceDek(
  keyring: Keyring,
  wrapped: Uint8Array,
  fromVersion: number,
  workspaceId: string,
): { wrapped: Buffer; kekVersion: number } {
  const dek = unwrapWorkspaceDek(keyring, wrapped, fromVersion, workspaceId);
  return {
    wrapped: wrapWorkspaceDek(keyring.current, dek, workspaceId),
    kekVersion: keyring.current.version,
  };
}
