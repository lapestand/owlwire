import { describe, expect, it } from 'vitest';
import { passkeyRelyingParty } from './auth.js';

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
});
