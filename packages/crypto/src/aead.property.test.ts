import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DecryptError, openJson, sealJson } from './aead.js';

const key = fc.uint8Array({ minLength: 32, maxLength: 32 });

/** Lone UTF-16 surrogates: valid in a JavaScript string, but not representable in UTF-8. */
const surrogate = fc.integer({ min: 0xd800, max: 0xdfff }).map((u) => String.fromCharCode(u));

/**
 * Any JavaScript string, biased towards lone surrogates and U+FFFD (what UTF-8 encoding turns a lone surrogate into)
 * so the encoding edge cases come up within the default number of runs.
 */
const anyAad = fc.string({
  unit: fc.oneof(
    fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }),
    surrogate,
    fc.constant('\uFFFD'),
  ),
  maxLength: 64,
});
const isWellFormed = (s: string) => !/\p{Cs}/u.test(s);
const wellFormedAad = anyAad.filter(isWellFormed);

/** A second AAD: unrelated, or the first one with a single UTF-16 code unit replaced. */
const otherAad = (a: string) =>
  fc.oneof(
    anyAad,
    fc
      .tuple(
        fc.nat(),
        fc.oneof(fc.integer({ min: 0, max: 0xffff }), fc.integer({ min: 0xd800, max: 0xdfff })),
      )
      .map(([i, unit]) => {
        const c = String.fromCharCode(unit);
        if (a.length === 0) return c;
        const j = i % a.length;
        return a.slice(0, j) + c + a.slice(j + 1);
      }),
  );

const json = fc.jsonValue({ stringUnit: 'binary', maxDepth: 4 });

/** What JSON can carry: `-0` becomes `0`, and so on. */
const viaJson = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('AEAD properties', () => {
  it('sealJson/openJson round-trips any JSON value', () => {
    fc.assert(
      fc.property(key, json, wellFormedAad, (k, value, a) => {
        expect(openJson(k, sealJson(k, value, a), a)).toEqual(viaJson(value));
      }),
    );
  });

  it('rejects a ciphertext with any byte flipped', () => {
    fc.assert(
      fc.property(
        key,
        json,
        wellFormedAad,
        fc.nat(),
        fc.integer({ min: 1, max: 255 }),
        (k, value, a, index, mask) => {
          const sealed = sealJson(k, value, a);
          const i = index % sealed.length;
          sealed[i] = (sealed[i] as number) ^ mask;
          expect(() => openJson(k, sealed, a)).toThrow(DecryptError);
        },
      ),
    );
  });

  it('rejects a ciphertext opened with a different AAD', () => {
    fc.assert(
      fc.property(
        key,
        json,
        wellFormedAad.chain((a) => fc.tuple(fc.constant(a), otherAad(a))),
        (k, value, [a, b]) => {
          fc.pre(a !== b);
          const sealed = sealJson(k, value, a);
          expect(() => openJson(k, sealed, b)).toThrow(DecryptError);
        },
      ),
    );
  });

  it('refuses to seal under an AAD that UTF-8 cannot represent', () => {
    fc.assert(
      fc.property(key, json, anyAad, (k, value, a) => {
        fc.pre(!isWellFormed(a));
        expect(() => sealJson(k, value, a)).toThrow(RangeError);
      }),
    );
  });
});
