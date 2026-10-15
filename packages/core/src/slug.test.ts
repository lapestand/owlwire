import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  generateSlug,
  isValidSlug,
  PERSONAL_SLUG_PATTERN,
  personalSlug,
  RESERVED_SLUGS,
  SLUG_PATTERN,
  slugify,
} from './slug.js';

describe('slug', () => {
  it('transliterates Turkish characters', () => {
    expect(slugify('Işık Çağı Şövalyeleri')).toBe('isik-cagi-sovalyeleri');
    expect(slugify('İstanbul Güneşi')).toBe('istanbul-gunesi');
  });

  it('collapses separators and trims dashes', () => {
    expect(slugify('  --Kurt  Sürüsü!!-- ')).toBe('kurt-surusu');
  });

  it('pins how other scripts fold (only Turkish letters are transliterated)', () => {
    // Letters with no decomposition are dropped, not transliterated: users pick their own slug where it matters.
    expect(slugify('Straße')).toBe('stra-e');
    expect(slugify('København')).toBe('k-benhavn');
    // Compatibility forms fold to ASCII (NFKD), so a full-width reserved name still lands on the reserved one.
    expect(slugify('ａｄｍｉｎ')).toBe('admin');
    expect(RESERVED_SLUGS.has(slugify('ａｄｍｉｎ'))).toBe(true);
    expect(slugify('ﬁsh')).toBe('fish');
    // Other accents are stripped to the base letter.
    expect(slugify('Café Zoë')).toBe('cafe-zoe');
  });

  it('returns an empty string for names without letters or digits', () => {
    expect(slugify('🙂 !!!')).toBe('');
  });

  it('generates a valid slug with suffix, even for empty or long names', () => {
    for (const name of ['Kurt Sürüsü', '🙂', 'x'.repeat(200)]) {
      const s = generateSlug(name, 'a1b2c3');
      expect(s).toMatch(SLUG_PATTERN);
      expect(s.endsWith('-a1b2c3')).toBe(true);
      expect(s.length).toBeLessThanOrEqual(40);
    }
    expect(generateSlug('🙂', 'a1b2c3')).toBe('workspace-a1b2c3');
  });

  it('builds the reserved personal slug from a user id', () => {
    const s = personalSlug('0192F3A4-5B6C-7D8E-9F01-23456789ABCD');
    expect(s).toBe('p-0192f3a45b6c7d8e9f0123456789abcd');
    expect(s).toMatch(PERSONAL_SLUG_PATTERN);
    expect(s).toMatch(SLUG_PATTERN);
  });

  it('rejects invalid slugs', () => {
    for (const bad of ['ab', '-abc', 'abc-', 'ABC', 'a_b_c', 'a'.repeat(41)]) {
      expect(SLUG_PATTERN.test(bad)).toBe(false);
    }
  });
});

describe('slug invariants', () => {
  it('slugify is idempotent and only emits slug characters', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (s) => {
        const once = slugify(s);
        expect(slugify(once)).toBe(once);
        expect(once).toMatch(/^([a-z0-9]+(-[a-z0-9]+)*)?$/);
      }),
    );
  });

  it('slugify keeps something whenever the input has an ASCII letter or digit', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 60 }),
        fc.stringMatching(/^[A-Za-z0-9]$/),
        fc.string({ unit: 'binary', maxLength: 60 }),
        (before, anchor, after) => {
          const out = slugify(`${before}${anchor}${after}`);
          expect(out.length).toBeGreaterThan(0);
          expect(out).toContain(anchor.toLowerCase());
        },
      ),
    );
  });

  it('generateSlug always yields a valid slug ending in the suffix', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 120 }),
        fc.stringMatching(/^[a-z0-9]{1,8}$/),
        (name, suffix) => {
          const s = generateSlug(name, suffix);
          expect(s).toMatch(SLUG_PATTERN);
          expect(s.endsWith(`-${suffix}`)).toBe(true);
          expect(s.length).toBeGreaterThanOrEqual(3);
          expect(s.length).toBeLessThanOrEqual(40);
        },
      ),
    );
  });
});

describe('slug hardening', () => {
  it('rejects consecutive dashes and punycode prefixes', () => {
    for (const bad of ['a--b', 'xn--abc', 'abc--']) expect(SLUG_PATTERN.test(bad)).toBe(false);
    expect(SLUG_PATTERN.test('a-b-c')).toBe(true);
  });

  it('rejects reserved and personal-namespace slugs for user-chosen names', () => {
    for (const r of [
      'api',
      'admin',
      'auth',
      'www',
      'app',
      'static',
      'assets',
      'health',
      'readyz',
      'healthz',
      'login',
      'logout',
      'signup',
      'settings',
      'invite',
      'invitations',
      'workspaces',
      'me',
      'v1',
      'hooks',
      'events',
      'deliveries',
    ]) {
      expect(RESERVED_SLUGS.has(r)).toBe(true);
      expect(isValidSlug(r)).toBe(false);
    }
    expect(isValidSlug(personalSlug('0192f3a4-5b6c-7d8e-9f01-23456789abcd'))).toBe(false);
    expect(isValidSlug('kurt-surusu')).toBe(true);
    expect(isValidSlug('ab')).toBe(false);
  });

  it('refuses unusable suffixes', () => {
    for (const bad of ['', 'A1', 'a-b', 'x'.repeat(17)]) {
      expect(() => generateSlug('name', bad)).toThrow(RangeError);
    }
  });

  it('refuses non-uuid ids for personal slugs', () => {
    expect(() => personalSlug('not-a-uuid')).toThrow(RangeError);
    expect(() => personalSlug('')).toThrow(RangeError);
  });
});
