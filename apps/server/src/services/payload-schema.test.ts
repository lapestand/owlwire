import { describe, expect, it } from 'vitest';
import { PayloadSchemaRegistry } from './payload-schema.js';

const schema = {
  type: 'object',
  required: ['target'],
  properties: { target: { type: 'string' }, count: { type: 'integer', minimum: 0 } },
};

describe('PayloadSchemaRegistry', () => {
  it('accepts a valid JSON Schema', () => {
    expect(new PayloadSchemaRegistry().checkSchema(schema)).toEqual({ ok: true });
  });

  it('rejects an invalid JSON Schema with a readable detail', () => {
    const r = new PayloadSchemaRegistry().checkSchema({ type: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/type/);
  });

  it('rejects remote references', () => {
    const r = new PayloadSchemaRegistry().checkSchema({ $ref: 'https://example.com/s.json' });
    expect(r.ok).toBe(false);
  });

  it('rejects schemas larger than 16384 bytes', () => {
    const r = new PayloadSchemaRegistry().checkSchema({
      type: 'object',
      description: 'x'.repeat(17_000),
    });
    expect(r).toEqual({ ok: false, detail: 'payloadSchema exceeds 16384 bytes' });
  });

  it('allows two apps to use the same $id', () => {
    const reg = new PayloadSchemaRegistry();
    const withId = { ...schema, $id: 'https://tracker.example/event.json' };
    expect(reg.validate('app1:t:1', withId, { target: 'x' })).toEqual({ ok: true });
    expect(reg.validate('app2:t:1', withId, { target: 'y' })).toEqual({ ok: true });
  });

  it('validates data and reports the failing path', () => {
    const r = new PayloadSchemaRegistry().validate('a:t:1', schema, { target: 'x', count: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('data/count');
  });

  it('caches compiled validators and evicts the oldest entry', () => {
    const reg = new PayloadSchemaRegistry({ maxEntries: 2 });
    reg.validate('a', schema, { target: 'x' });
    reg.validate('b', schema, { target: 'x' });
    reg.validate('a', schema, { target: 'x' });
    expect(reg.size).toBe(2);
    reg.validate('c', schema, { target: 'x' });
    expect(reg.size).toBe(2);
  });

  describe('pattern handling', () => {
    it('does not backtrack catastrophically on hostile patterns', () => {
      const reg = new PayloadSchemaRegistry();
      const hostile = { type: 'string', pattern: '^(a+)+$' };
      const started = performance.now();
      const r = reg.validate('evil', hostile, `${'a'.repeat(50)}b`);
      expect(performance.now() - started).toBeLessThan(1000);
      expect(r.ok).toBe(false);
    });

    it('refuses patterns the linear engine cannot express', () => {
      const reg = new PayloadSchemaRegistry();
      for (const pattern of ['(a)\\1', '(?=a)a', '(?<=a)b']) {
        expect(reg.checkSchema({ type: 'string', pattern }).ok).toBe(false);
      }
      expect(reg.validate('k', { type: 'string', pattern: '(a)\\1' }, 'aa').ok).toBe(false);
    });

    it('still validates ordinary patterns and patternProperties', () => {
      const reg = new PayloadSchemaRegistry();
      const s = {
        type: 'object',
        properties: { id: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' } },
        patternProperties: { '^x-': { type: 'string' } },
        additionalProperties: false,
      };
      expect(reg.validate('p', s, { id: 'ABC-12', 'x-a': 'v' })).toEqual({ ok: true });
      expect(reg.validate('p', s, { id: 'abc' }).ok).toBe(false);
      expect(reg.validate('p', s, { 'x-a': 1 }).ok).toBe(false);
      expect(reg.validate('p2', { type: 'string', pattern: 'foo' }, 'a foo b').ok).toBe(true);
      expect(reg.validate('q', { type: 'string', pattern: 'bar' }, 'a foo b').ok).toBe(false);
    });
  });
});
