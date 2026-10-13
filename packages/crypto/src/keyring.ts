import { randomBytes } from 'node:crypto';
import { KEY_BYTES, type Kek, type KekRing } from './keys.js';

/** P0 KekRing'in sürümle arama eklenmiş hâli (R90). Deps.keyring tipi. */
export interface Keyring extends KekRing {
  byVersion(version: number): Kek | undefined;
}

export class KeyringConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyringConfigError';
  }
}

/** KEK versions fit the u16 header used by the P0 legacy format. */
const MAX_KEK_VERSION = 0xffff;

function isValidKekVersion(version: number): boolean {
  return Number.isInteger(version) && version >= 1 && version <= MAX_KEK_VERSION;
}

export function createKeyring(current: Kek, previous: Kek | null = null): Keyring {
  if (!isValidKekVersion(current.version)) {
    throw new KeyringConfigError('OWLWIRE_KEK_VERSION must be an integer between 1 and 65535');
  }
  if (previous && !isValidKekVersion(previous.version)) {
    throw new KeyringConfigError(
      'OWLWIRE_KEK_PREVIOUS version must be an integer between 1 and 65535',
    );
  }
  if (previous && previous.version === current.version) {
    throw new KeyringConfigError(
      'OWLWIRE_KEK_PREVIOUS must have a different version than OWLWIRE_KEK_VERSION',
    );
  }
  if (previous && Buffer.compare(Buffer.from(previous.key), Buffer.from(current.key)) === 0) {
    throw new KeyringConfigError(
      'OWLWIRE_KEK_PREVIOUS equals OWLWIRE_KEK; generate a new key for rotation',
    );
  }
  return {
    current,
    previous,
    byVersion(version: number): Kek | undefined {
      if (version === current.version) return current;
      if (previous && version === previous.version) return previous;
      return undefined;
    },
  };
}

export function generateKek(version: number): Kek {
  if (!isValidKekVersion(version)) {
    throw new RangeError('KEK version must be an integer between 1 and 65535');
  }
  return { version, key: randomBytes(KEY_BYTES) };
}
