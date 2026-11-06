import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it, vi } from 'vitest';
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

  describe('pattern cost', () => {
    it('refuses patterns longer than 512 characters', () => {
      const reg = new PayloadSchemaRegistry();
      expect(reg.checkSchema({ type: 'string', pattern: 'a'.repeat(513) }).ok).toBe(false);
      expect(reg.checkSchema({ type: 'string', pattern: 'a'.repeat(512) }).ok).toBe(true);
    });

    it('refuses repetition bounds above 100 and accepts 100', () => {
      const reg = new PayloadSchemaRegistry();
      for (const pattern of ['a{101}', 'a{1,101}', 'a{101,}', '(?:a|aa){1,999}$']) {
        expect(reg.checkSchema({ type: 'string', pattern }).ok).toBe(false);
      }
      for (const pattern of ['a{100}', 'a{1,100}', 'a{100,}', 'a{0,5}']) {
        expect(reg.checkSchema({ type: 'string', pattern }).ok).toBe(true);
      }
      const r = reg.validate('rep', { type: 'string', pattern: '^(?:a|aa){1,100}$' }, 'aaaa');
      expect(r.ok).toBe(true);
    });
  });

  describe('resource limits', () => {
    it('compiles a ref-heavy schema quickly', () => {
      const refs = Array.from({ length: 540 }, () => ({ $ref: '#/$defs/a' }));
      const props = Object.fromEntries(
        Array.from({ length: 120 }, (_, i) => [`p${i}`, { type: 'string' }]),
      );
      const heavy = { $defs: { a: { type: 'object', properties: props } }, allOf: refs };
      expect(JSON.stringify(heavy).length).toBeLessThanOrEqual(16_384);
      const started = performance.now();
      expect(new PayloadSchemaRegistry().checkSchema(heavy)).toEqual({ ok: true });
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('gives every compile its own Ajv instance so nothing accumulates', () => {
      const instances = new Set<unknown>();
      const spy = vi.spyOn(Ajv2020.prototype, 'compile').mockImplementation(function (
        this: unknown,
      ) {
        instances.add(this);
        return (() => true) as never;
      });
      try {
        const reg = new PayloadSchemaRegistry({ maxEntries: 2 });
        for (let i = 0; i < 10; i++) reg.validate(`k${i}`, { type: 'object' }, {});
        for (let i = 0; i < 5; i++) reg.checkSchema({ type: 'object' });
        expect(instances.size).toBe(15);
        expect(reg.size).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('reports excessive nesting instead of throwing', () => {
      const recursive = {
        $defs: { n: { type: 'array', items: { $ref: '#/$defs/n' } } },
        $ref: '#/$defs/n',
      };
      let data: unknown[] = [];
      for (let i = 0; i < 30_000; i++) data = [data];
      const r = new PayloadSchemaRegistry().validate('deep', recursive, data);
      expect(r).toEqual({ ok: false, detail: 'payload is nested too deeply' });
    });

    it('does not write to the console for unknown formats', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const reg = new PayloadSchemaRegistry();
        expect(reg.checkSchema({ type: 'string', format: 'email' }).ok).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });
});
