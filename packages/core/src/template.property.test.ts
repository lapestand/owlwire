import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseTemplate, renderTemplateString } from './template.js';

/** Any text without `{{`, which the template language must pass through untouched. */
const plainText = fc.string({ unit: 'binary', maxLength: 200 }).filter((s) => !s.includes('{{'));

const plainSegment = fc.stringMatching(/^[A-Za-z0-9_-]{1,8}$/);
const quotedKey = fc
  .string({ unit: 'binary', maxLength: 8 })
  .map((k) => `["${k.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"]`);
const accessor = fc.oneof(
  plainSegment.map((s) => `.${s}`),
  fc.nat({ max: 5 }).map((n) => `[${n}]`),
  quotedKey,
  fc.constantFrom('.__proto__', '.constructor', '.prototype', '["__proto__"]'),
);
const path = fc
  .tuple(plainSegment, fc.array(accessor, { maxLength: 5 }))
  .map(([head, rest]) => `${head}${rest.join('')}`);
const placeholder = fc
  .tuple(fc.constantFrom('', ' ', '  ', '\t', '\n'), path, fc.constantFrom('', ' ', '\n'))
  .map(([before, p, after]) => `{{${before}${p}${after}}}`);

/** A valid template: plain text with placeholders between the pieces. */
const validTemplate = fc
  .array(fc.oneof(plainText, placeholder), { maxLength: 8 })
  .map((pieces) => pieces.join(''))
  .filter((tpl) => parseTemplate(tpl).ok);

describe('template language properties', () => {
  it('returns text without {{ unchanged, whatever the data', () => {
    fc.assert(
      fc.property(plainText, fc.anything(), (text, data) => {
        expect(renderTemplateString(text, data)).toBe(text);
      }),
    );
  });

  it('accepts every generated path template', () => {
    fc.assert(
      fc.property(placeholder, (tpl) => {
        expect(parseTemplate(tpl).ok).toBe(true);
      }),
    );
  });

  it('never throws on a valid template, whatever the data', () => {
    fc.assert(
      fc.property(
        validTemplate,
        fc.anything({ withNullPrototype: true, withBigInt: true }),
        (tpl, data) => {
          expect(typeof renderTemplateString(tpl, data)).toBe('string');
        },
      ),
    );
  });
});
