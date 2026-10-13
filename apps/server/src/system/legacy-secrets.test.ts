import { createKeyring, createSecretBox, DecryptError, generateKek } from '@owlwire/crypto';
import type { OwlwireDb } from '@owlwire/db';
import { describe, expect, it, vi } from 'vitest';
import { legacyDecryptor, upgradeLegacySecrets } from './legacy-secrets.js';

const system = vi.hoisted(() => ({
  backfillWorkspaceKeys: vi.fn(),
  upgradeLegacyConnectionSecrets: vi.fn(),
}));

vi.mock('@owlwire/db/system', () => ({ SYSTEM: { system: true }, ...system }));

describe('legacyDecryptor', () => {
  it('decrypts a P0 SecretBox blob with the current KEK', () => {
    const ring = createKeyring(generateKek(1));
    const ct = createSecretBox(ring).seal({ botToken: 'x' });
    expect(legacyDecryptor(ring)(ct)).toEqual({ botToken: 'x' });
  });

  it('opens blobs sealed with the previous KEK during rotation', () => {
    const old = generateKek(1);
    const ct = createSecretBox(createKeyring(old)).seal({ botToken: 'y' });
    expect(legacyDecryptor(createKeyring(generateKek(2), old))(ct)).toEqual({ botToken: 'y' });
  });

  it('throws DecryptError without leaking content when no key works', () => {
    const ct = createSecretBox(createKeyring(generateKek(1))).seal({ botToken: 'z' });
    const run = () => legacyDecryptor(createKeyring(generateKek(5)))(ct);
    expect(run).toThrow(DecryptError);
    expect(run).not.toThrow(/z/);
  });

  it('rejects non-object payloads', () => {
    const ring = createKeyring(generateKek(1));
    expect(() => legacyDecryptor(ring)(createSecretBox(ring).seal('just a string'))).toThrow(
      DecryptError,
    );
  });
});

describe('upgradeLegacySecrets', () => {
  const db = {} as OwlwireDb;

  function logger() {
    return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it('backfills keys, then upgrades with a decryptor bound to the keyring, and logs counts only', async () => {
    const ring = createKeyring(generateKek(1));
    system.backfillWorkspaceKeys.mockResolvedValueOnce(2);
    system.upgradeLegacyConnectionSecrets.mockImplementationOnce(async (_scope, _db, decrypt) => {
      expect(decrypt(createSecretBox(ring).seal({ botToken: 'secret-value' }))).toEqual({
        botToken: 'secret-value',
      });
      return {
        upgraded: 3,
        failed: [{ connectionId: 'c-1', error: 'Error: unknown secret box format' }],
      };
    });
    const log = logger();

    const result = await upgradeLegacySecrets(db, ring, log);

    expect(result).toEqual({
      keysCreated: 2,
      upgraded: 3,
      failed: [{ connectionId: 'c-1', error: 'Error: unknown secret box format' }],
    });
    expect(system.backfillWorkspaceKeys).toHaveBeenCalledWith({ system: true }, db);
    expect(log.info).toHaveBeenCalledWith(
      { keysCreated: 2, upgraded: 3, failed: 1 },
      'legacy secrets upgraded to workspace keys',
    );
    expect(log.error).toHaveBeenCalledWith(
      { connectionId: 'c-1', error: 'Error: unknown secret box format' },
      'legacy connection secret could not be upgraded',
    );
    expect(
      JSON.stringify([log.info.mock.calls, log.warn.mock.calls, log.error.mock.calls]),
    ).not.toContain('secret-value');
  });

  it('stays quiet when there is nothing to do', async () => {
    system.backfillWorkspaceKeys.mockResolvedValueOnce(0);
    system.upgradeLegacyConnectionSecrets.mockResolvedValueOnce({ upgraded: 0, failed: [] });
    const log = logger();

    expect(await upgradeLegacySecrets(db, createKeyring(generateKek(1)), log)).toEqual({
      keysCreated: 0,
      upgraded: 0,
      failed: [],
    });
    expect(log.info).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});
