import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  generateSlug,
  PERSONAL_SLUG_PATTERN,
  personalSlug,
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

  it('generateSlug always yields a valid slug ending in the suffix', () => {
    fc.assert(
      fc.property(
        fc.string({ unit: 'binary', maxLength: 120 }),
        fc.stringMatching(/^[a-z0-9]{1,8}$/),
        (name, suffix) => {
          const s = generateSlug(name, suffix);
          expect(s).toMatch(SLUG_PATTERN);
          expect(s.endsWith(`-${suffix}`)).toBe(true);
        },
      ),
    );
  });
});
