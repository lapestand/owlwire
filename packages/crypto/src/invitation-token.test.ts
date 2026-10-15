import { describe, expect, it } from 'vitest';
import { generateToken, hashToken, INVITATION_TOKEN_PREFIX } from './tokens.js';

describe('invitation tokens', () => {
  it('generates ow_inv_ tokens with a 43 character base62 body', () => {
    const token = generateToken('inv');
    expect(INVITATION_TOKEN_PREFIX).toBe('ow_inv_');
    expect(token.startsWith(INVITATION_TOKEN_PREFIX)).toBe(true);
    expect(token.slice(INVITATION_TOKEN_PREFIX.length)).toMatch(/^[0-9A-Za-z]{43}$/);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps the existing token kinds unchanged', () => {
    expect(generateToken('inst').startsWith('ow_inst_')).toBe(true);
    expect(generateToken('app').startsWith('ow_app_')).toBe(true);
  });
});
