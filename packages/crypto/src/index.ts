export {
  buildAad,
  DecryptError,
  openBytes,
  openJson,
  sealBytes,
  sealJson,
} from './aead.js';
export {
  rewrapWorkspaceDek,
  UnknownKekVersionError,
  unwrapWorkspaceDek,
  wrapWorkspaceDek,
} from './dek.js';
// wrapDek/unwrapDek are legacy envelope internals; not part of the public API.
export {
  createSecretBox,
  decryptJson,
  encryptJson,
  generateDek,
  type SecretBox,
} from './envelope.js';
export { createKeyring, generateKek, type Keyring, KeyringConfigError } from './keyring.js';
export * from './keys.js';
export * from './tokens.js';
