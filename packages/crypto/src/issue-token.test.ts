import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { issueToken, safeEqual, tokenKind, tokenPrefix } from './tokens.js';

describe('issueToken', () => {
  it('issues installation tokens with 43 base62 characters after the prefix', () => {
    const t = issueToken('inst');
    expect(t.token).toMatch(/^ow_inst_[0-9A-Za-z]{43}$/);
    expect(t.prefix).toBe(tokenPrefix(t.token));
    expect(t.prefix).toBe(t.token.slice(0, 12));
    expect(t.hash).toBe(createHash('sha256').update(t.token).digest('hex'));
  });

  it('issues app keys with the ow_app_ prefix', () => {
    expect(issueToken('app').token).toMatch(/^ow_app_[0-9A-Za-z]{43}$/);
  });

  it('never repeats a token', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => issueToken('app').token));
    expect(seen.size).toBe(1000);
  });

  it('produces hashes that compare in constant time', () => {
    const a = issueToken('inst');
    expect(safeEqual(a.hash, issueToken('inst').hash)).toBe(false);
    expect(safeEqual(a.hash, `${a.hash}`)).toBe(true);
  });
});

describe('tokenKind', () => {
  it('detects the token kind from its prefix', () => {
    expect(tokenKind('ow_inst_abc')).toBe('inst');
    expect(tokenKind('ow_app_abc')).toBe('app');
    expect(tokenKind('ow_inv_abc')).toBeNull();
    expect(tokenKind('ghp_abc')).toBeNull();
  });
});
