import { describe, expect, it } from 'vitest';
import {
  base62,
  generateToken,
  hashToken,
  isInstallationToken,
  safeEqual,
  tokenPrefix,
  verifyTokenHash,
} from './tokens.js';

describe('base62', () => {
  it('encodes big-endian with left padding', () => {
    expect(base62(Uint8Array.of(0, 0), 3)).toBe('000');
    expect(base62(Uint8Array.of(61), 1)).toBe('z');
    expect(base62(Uint8Array.of(62), 2)).toBe('10');
    expect(base62(new Uint8Array(32).fill(0xff), 43)).toHaveLength(43);
  });
});

describe('tokens', () => {
  it('generates prefixed fixed-length installation and app tokens', () => {
    const inst = generateToken('inst');
    const app = generateToken('app');
    expect(inst).toMatch(/^ow_inst_[0-9A-Za-z]{43}$/);
    expect(app).toMatch(/^ow_app_[0-9A-Za-z]{43}$/);
    expect(isInstallationToken(inst)).toBe(true);
    expect(isInstallationToken(app)).toBe(false);
    expect(isInstallationToken(`${inst}x`)).toBe(false);
  });

  it('is unique', () => {
    const set = new Set(Array.from({ length: 200 }, () => generateToken('inst')));
    expect(set.size).toBe(200);
  });

  it('hashes with sha256 hex and exposes a 12 character prefix', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    const t = generateToken('inst');
    expect(tokenPrefix(t)).toBe(t.slice(0, 12));
    expect(tokenPrefix(t).startsWith('ow_inst_')).toBe(true);
  });

  it('verifies hashes and compares strings safely', () => {
    const t = generateToken('inst');
    expect(verifyTokenHash(t, hashToken(t))).toBe(true);
    expect(verifyTokenHash(t, hashToken(`${t}0`))).toBe(false);
    expect(safeEqual('same', 'same')).toBe(true);
    expect(safeEqual('same', 'different-length')).toBe(false);
  });
});
