import { describe, expect, it } from 'vitest';
import { assertUserVerified, passkeyOptions, passkeyRelyingParty } from './passkey.js';

describe('passkey relying party', () => {
  it('binds passkeys to the host and origin of the public URL', () => {
    expect(passkeyRelyingParty('https://notify.example.test')).toEqual({
      rpID: 'notify.example.test',
      origin: 'https://notify.example.test',
    });
    expect(passkeyRelyingParty('http://localhost:8080')).toEqual({
      rpID: 'localhost',
      origin: 'http://localhost:8080',
    });
  });

  it('pins the relying party and asks the authenticator to verify the user', () => {
    const options = passkeyOptions('https://notify.example.test');
    expect(options).toMatchObject({
      rpID: 'notify.example.test',
      origin: 'https://notify.example.test',
      rpName: 'Owlwire',
      authenticatorSelection: { userVerification: 'required' },
    });
  });
});

describe('passkey user verification', () => {
  it('accepts only a response the authenticator verified the user for', () => {
    expect(() => assertUserVerified({ userVerified: true })).not.toThrow();
    expect(() => assertUserVerified({ userVerified: false })).toThrow(
      'The authenticator did not verify the user',
    );
    expect(() => assertUserVerified(undefined)).toThrow();
  });

  it('refuses unverified registration and sign-in responses in the plugin hooks', async () => {
    const options = passkeyOptions('https://notify.example.test');
    const register = options.registration?.afterVerification;
    const authenticate = options.authentication?.afterVerification;
    if (!register || !authenticate) throw new Error('verification hooks are missing');
    // Only the fields the hooks read; the rest of the library's arguments do not matter here.
    const registration = (userVerified: boolean) =>
      register({
        verification: { verified: true, registrationInfo: { userVerified } },
      } as unknown as Parameters<typeof register>[0]);
    const authentication = (userVerified: boolean) =>
      authenticate({
        verification: { verified: true, authenticationInfo: { userVerified } },
      } as unknown as Parameters<typeof authenticate>[0]);
    await expect(Promise.resolve().then(() => registration(false))).rejects.toThrow();
    await expect(Promise.resolve().then(() => registration(true))).resolves.toBeUndefined();
    await expect(Promise.resolve().then(() => authentication(false))).rejects.toThrow();
    await expect(Promise.resolve().then(() => authentication(true))).resolves.toBeUndefined();
  });
});
