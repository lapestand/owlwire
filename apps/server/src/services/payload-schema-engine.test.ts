import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it, vi } from 'vitest';
import { PayloadSchemaEngine } from './payload-schema-engine.js';

const schema = {
  type: 'object',
  required: ['target'],
  properties: { target: { type: 'string' }, count: { type: 'integer', minimum: 0 } },
};

// Runs the engine in-process. These are the static limits, the first line of defence; the
// worker deadline in payload-schema.test.ts bounds whatever they miss.
describe('PayloadSchemaEngine', () => {
  it('accepts a valid JSON Schema', () => {
    expect(new PayloadSchemaEngine().checkSchema(schema)).toEqual({ ok: true });
  });

  it('rejects an invalid JSON Schema with a readable detail', () => {
    const r = new PayloadSchemaEngine().checkSchema({ type: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/type/);
  });

  it('rejects remote references', () => {
    const r = new PayloadSchemaEngine().checkSchema({ $ref: 'https://example.com/s.json' });
    expect(r.ok).toBe(false);
  });

  it('allows two apps to use the same $id', () => {
    const reg = new PayloadSchemaEngine();
    const withId = { ...schema, $id: 'https://tracker.example/event.json' };
    expect(reg.validate('app1:t:1', withId, { target: 'x' })).toEqual({ ok: true });
    expect(reg.validate('app2:t:1', withId, { target: 'y' })).toEqual({ ok: true });
  });

  it('validates data and reports the failing path', () => {
    const r = new PayloadSchemaEngine().validate('a:t:1', schema, { target: 'x', count: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('data/count');
  });

  it('caches compiled validators and evicts the oldest entry', () => {
    const reg = new PayloadSchemaEngine({ maxEntries: 2 });
    reg.validate('a', schema, { target: 'x' });
    reg.validate('b', schema, { target: 'x' });
    reg.validate('a', schema, { target: 'x' });
    expect(reg.size).toBe(2);
    reg.validate('c', schema, { target: 'x' });
    expect(reg.size).toBe(2);
  });

  describe('pattern handling', () => {
    it('does not backtrack catastrophically on hostile patterns', () => {
      const reg = new PayloadSchemaEngine();
      const hostile = { type: 'string', pattern: '^(a+)+$' };
      const started = performance.now();
      const r = reg.validate('evil', hostile, `${'a'.repeat(50)}b`);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(r.ok).toBe(false);
    });

    it('refuses patterns the linear engine cannot express', () => {
      const reg = new PayloadSchemaEngine();
      for (const pattern of ['(a)\\1', '(?=a)a', '(?<=a)b']) {
        expect(reg.checkSchema({ type: 'string', pattern }).ok).toBe(false);
      }
      expect(reg.validate('k', { type: 'string', pattern: '(a)\\1' }, 'aa').ok).toBe(false);
    });

    it('still validates ordinary patterns and patternProperties', () => {
      const reg = new PayloadSchemaEngine();
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
      const reg = new PayloadSchemaEngine();
      expect(reg.checkSchema({ type: 'string', pattern: 'a'.repeat(513) }).ok).toBe(false);
      expect(reg.checkSchema({ type: 'string', pattern: 'a'.repeat(512) }).ok).toBe(true);
    });

    it('refuses repetition bounds above 100 and accepts 100', () => {
      const reg = new PayloadSchemaEngine();
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
      const refs = Array.from({ length: 16 }, () => ({ $ref: '#/$defs/a' }));
      const props = Object.fromEntries(
        Array.from({ length: 120 }, (_, i) => [`p${i}`, { type: 'string' }]),
      );
      const heavy = { $defs: { a: { type: 'object', properties: props } }, allOf: refs };
      expect(JSON.stringify(heavy).length).toBeLessThanOrEqual(16_384);
      const started = performance.now();
      expect(new PayloadSchemaEngine().checkSchema(heavy)).toEqual({ ok: true });
      // Inlined, this took tens of seconds; the ceiling only proves it is bounded.
      expect(performance.now() - started).toBeLessThan(5000);
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
        const reg = new PayloadSchemaEngine({ maxEntries: 2 });
        for (let i = 0; i < 10; i++) reg.validate(`k${i}`, { type: 'object' }, {});
        for (let i = 0; i < 5; i++) reg.checkSchema({ type: 'object' });
        expect(instances.size).toBe(15);
        expect(reg.size).toBe(2);
      } finally {
        spy.mockRestore();
      }
    });

    it('reports a stack overflow while validating as nested too deeply', () => {
      const overflow = () => {
        throw new RangeError('Maximum call stack size exceeded');
      };
      const spy = vi.spyOn(Ajv2020.prototype, 'compile').mockReturnValue(overflow as never);
      try {
        const r = new PayloadSchemaEngine().validate('deep', { type: 'array' }, []);
        expect(r).toEqual({ ok: false, detail: 'payload is nested too deeply' });
      } finally {
        spy.mockRestore();
      }
    });

    it('never throws for a deeply nested schema and payload', () => {
      let schema: Record<string, unknown> = { type: 'string' };
      let data: unknown = 'x';
      for (let i = 0; i < 1500; i++) {
        schema = { type: 'array', items: schema };
        data = [data];
      }
      const r = new PayloadSchemaEngine().validate('deep', schema, data);
      expect(typeof r.ok).toBe('boolean');
    });

    it('does not write to the console for unknown formats', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const reg = new PayloadSchemaEngine();
        expect(reg.checkSchema({ type: 'string', format: 'email' }).ok).toBe(true);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('regex cost bounds', () => {
    const check = (pattern: string) =>
      new PayloadSchemaEngine().checkSchema({ type: 'string', pattern }).ok;

    it('refuses nested repetition whose product exceeds 100', () => {
      expect(check('(?:(?:a|aa|aaa|aaaa|aaaaa){10}){100}$')).toBe(false);
      expect(check('(?:a{11}){10}')).toBe(false);
      expect(check('(a{2,11}){10}')).toBe(false);
    });

    it('accepts a nested product of exactly 100 and flat repetitions', () => {
      expect(check('(?:(?:a|aa){10}){10}')).toBe(true);
      expect(check('(?:a{10}){10}')).toBe(true);
      expect(check('a{100}b{100}')).toBe(true);
      expect(check('((a){5}){5}(b){4}')).toBe(true);
    });

    it('refuses more than 32 regexes per schema, counting patternProperties', () => {
      const props = (n: number) =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, { pattern: `^a${i}$` }]));
      const reg = new PayloadSchemaEngine();
      expect(reg.checkSchema({ type: 'object', properties: props(32) }).ok).toBe(true);
      expect(reg.checkSchema({ type: 'object', properties: props(33) }).ok).toBe(false);
      const pp = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`^k${i}`, {}]));
      expect(reg.checkSchema({ patternProperties: pp, properties: props(13) }).ok).toBe(false);
      expect(reg.checkSchema({ patternProperties: pp, properties: props(12) }).ok).toBe(true);
    });

    it('fails validation for strings over 4096 characters checked against a pattern', () => {
      const reg = new PayloadSchemaEngine();
      const s = { type: 'string', pattern: '^a+$' };
      expect(reg.validate('long', s, 'a'.repeat(5000))).toEqual({
        ok: false,
        detail: 'string too long for pattern',
      });
      expect(reg.validate('long', s, 'a'.repeat(4096))).toEqual({ ok: true });
      expect(reg.validate('free', { type: 'string' }, 'a'.repeat(5000))).toEqual({ ok: true });
    });

    it('refuses patterns whose estimated program size is too large', () => {
      const alt = 'a|aa|aaa|aaaa|aaaaa|aaaaaa|aaaaaaa|aaaaaaaa';
      expect(check(`(?:${alt}){100}$`)).toBe(false);
      expect(check('[a-z]{100}'.repeat(40))).toBe(false);
    });

    it('keeps the worst allowed patterns fast on a 4096 character string', () => {
      const alt = 'a|aa|aaa|aaaa';
      const worst = [
        `(?:(?:${alt}){10}){10}$`,
        `(?:${alt}){100}$`,
        `${'(?:a|aa){100}'.repeat(3)}$`,
        `${'[a-z]{100}'.repeat(12)}$`,
        `${'(?:a{1,100}b?)'.repeat(5)}$`,
      ];
      const input = `${'a'.repeat(4095)}b`;
      for (const [i, pattern] of worst.entries()) {
        const reg = new PayloadSchemaEngine();
        expect(reg.checkSchema({ type: 'string', pattern }).ok, pattern).toBe(true);
        const started = performance.now();
        const r = reg.validate(`w${i}`, { type: 'string', pattern }, input);
        // One test of the worst allowed pattern fits in the run-time budget: matching
        // completes with a real answer instead of being cut off.
        expect(r.ok || !/too expensive|too long/.test(r.detail), pattern).toBe(true);
        // Generous ceiling (coverage instrumentation slows matching several times).
        expect(performance.now() - started, pattern).toBeLessThan(2000);
      }
    });

    it('applies the complexity budget to the whole schema', () => {
      const reg = new PayloadSchemaEngine();
      const heavy = (n: number) => ({ type: 'string', pattern: `${'[a-z]{100}'.repeat(n)}$` });
      // Each pattern estimates to about 1500; together they pass the 2500 budget.
      expect(reg.checkSchema(heavy(15)).ok).toBe(true);
      const both = { type: 'object', properties: { a: heavy(15), b: heavy(15) } };
      expect(reg.checkSchema(both).ok).toBe(false);
      const patternPropsToo = {
        properties: { a: heavy(15) },
        patternProperties: { [`${'[a-z]{100}'.repeat(15)}$`]: {} },
      };
      expect(reg.checkSchema(patternPropsToo).ok).toBe(false);
    });

    it('keeps the worst whole schema fast with every string at 4096 characters', () => {
      // 11 x [a-z]{100} = 1100 per pattern, two of them plus a small one fit within 2500.
      const worst = `${'[a-z]{100}'.repeat(11)}$`;
      const schema = {
        type: 'object',
        properties: {
          a: { type: 'string', pattern: worst },
          b: { type: 'string', pattern: worst },
        },
        patternProperties: { '^k': { type: 'string', pattern: 'x{100}$' } },
        additionalProperties: { type: 'string' },
      };
      const reg = new PayloadSchemaEngine();
      expect(reg.checkSchema(schema)).toEqual({ ok: true });
      const long = `${'a'.repeat(4095)}b`;
      const data = { a: long, b: long, kk: long };
      const started = performance.now();
      const r = reg.validate('whole', schema, data);
      // Every pattern ran to a real answer within the budget (`kk` fails `x{100}$`).
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toMatch(/must match pattern/);
      expect(performance.now() - started).toBeLessThan(2000);
    });
  });

  describe('run time and reference limits', () => {
    const heavyPattern = `${'[a-z]{100}'.repeat(20)}$`;
    const refTo = (name: string) => ({ $ref: `#/$defs/${name}` });
    const long = `${'a'.repeat(4095)}b`;

    it('refuses more than 16 $ref occurrences at compile', () => {
      const refs = Array.from({ length: 766 }, () => refTo('p'));
      const schema = {
        $defs: { p: { type: 'string', pattern: heavyPattern } },
        type: 'array',
        items: { allOf: refs },
      };
      const r = new PayloadSchemaEngine().checkSchema(schema);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.detail).toMatch(/\$ref/);
      const sixteen = { ...schema, items: { allOf: refs.slice(0, 16) } };
      expect(new PayloadSchemaEngine().checkSchema(sixteen)).toEqual({ ok: true });
    });

    it('trips the run time budget for fan-out within 16 refs', () => {
      const schema = {
        $defs: { p: { type: 'string', pattern: heavyPattern } },
        type: 'array',
        items: { allOf: Array.from({ length: 15 }, () => refTo('p')) },
      };
      const reg = new PayloadSchemaEngine();
      expect(reg.checkSchema(schema).ok).toBe(true);
      const started = performance.now();
      const r = reg.validate(
        'fan',
        schema,
        Array.from({ length: 15 }, () => long),
      );
      expect(r).toEqual({ ok: false, detail: 'payload too expensive to validate' });
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('trips the budget for an array of long strings checked by one pattern', () => {
      const schema = {
        type: 'array',
        items: { type: 'string', pattern: `${'[a-z]{100}'.repeat(12)}$` },
      };
      const started = performance.now();
      const r = new PayloadSchemaEngine().validate(
        'arr',
        schema,
        Array.from({ length: 15 }, () => long),
      );
      expect(r).toEqual({ ok: false, detail: 'payload too expensive to validate' });
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('gives every validate call a fresh budget', () => {
      const schema = { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' } };
      const reg = new PayloadSchemaEngine();
      const data = Array.from({ length: 20 }, () => 'a'.repeat(4000));
      for (let i = 0; i < 50; i++)
        expect(reg.validate('fresh', schema, data)).toEqual({ ok: true });
    });

    it('refuses \\Q quoting that hides repetition from the nesting scan', () => {
      const reg = new PayloadSchemaEngine();
      const pattern = '\\Q)\\E(?:(?:a|aa|aaa|aaaa|aaaaa){10}){100}';
      expect(reg.checkSchema({ type: 'string', pattern }).ok).toBe(false);
      expect(reg.checkSchema({ type: 'string', pattern: '\\Qa.b\\E' }).ok).toBe(false);
    });

    it('refuses cyclic references', () => {
      const reg = new PayloadSchemaEngine();
      const self = { $defs: { a: { type: 'array', items: refTo('a') } }, ...refTo('a') };
      expect(reg.checkSchema(self).ok).toBe(false);
      const mutual = {
        $defs: { a: { properties: { x: refTo('b') } }, b: { properties: { y: refTo('a') } } },
        ...refTo('a'),
      };
      expect(reg.checkSchema(mutual).ok).toBe(false);
      expect(reg.checkSchema({ type: 'array', items: { $ref: '#' } }).ok).toBe(false);
      const anchored = {
        $defs: { a: { $anchor: 'node', properties: { x: { $ref: '#node' } } } },
        ...refTo('a'),
      };
      expect(reg.checkSchema(anchored).ok).toBe(false);
    });

    it('refuses references that are not local JSON pointers', () => {
      const reg = new PayloadSchemaEngine();
      for (const $ref of ['urn:x:a', 'other.json#/a', '#node', 'https://example.com/s.json']) {
        const r = reg.checkSchema({ $defs: { a: { type: 'string' } }, $ref });
        expect(r.ok, $ref).toBe(false);
        if (!r.ok) expect(r.detail).toMatch(/\$ref must be a local JSON pointer/);
      }
    });

    it('refuses nested $id and any anchor', () => {
      const reg = new PayloadSchemaEngine();
      const nested = { $defs: { a: { $id: 'urn:x:a', type: 'string' } }, ...refTo('a') };
      expect(reg.checkSchema(nested)).toEqual({
        ok: false,
        detail: '$id is only supported at the schema root',
      });
      for (const keyword of ['$anchor', '$dynamicAnchor']) {
        const s = { $defs: { a: { [keyword]: 'node', type: 'string' } }, ...refTo('a') };
        expect(reg.checkSchema(s)).toEqual({ ok: false, detail: `${keyword} is not supported` });
        expect(reg.checkSchema({ [keyword]: 'root', type: 'string' }).ok).toBe(false);
      }
    });

    it('refuses the recursive $id schema that escaped the cycle check', () => {
      const s = {
        $defs: {
          a: {
            $id: 'urn:x:a',
            type: 'array',
            items: { allOf: [{ $ref: 'urn:x:a' }, { $ref: 'urn:x:a' }] },
          },
        },
        $ref: 'urn:x:a',
      };
      const reg = new PayloadSchemaEngine();
      expect(reg.checkSchema(s).ok).toBe(false);
      let deep: unknown = [];
      for (let i = 0; i < 30; i++) deep = [deep];
      const started = performance.now();
      expect(reg.validate('idc', s, deep).ok).toBe(false);
      expect(performance.now() - started).toBeLessThan(2000);
    });

    it('keeps a root $id and local references working', () => {
      const reg = new PayloadSchemaEngine();
      const s = {
        $id: 'https://tracker.example/event.json',
        $defs: { s: { type: 'string' } },
        properties: { a: refTo('s'), b: { $ref: '#/properties/a' } },
      };
      expect(reg.validate('root-id', s, { a: 'x', b: 'y' })).toEqual({ ok: true });
      expect(reg.validate('root-id', s, { b: 1 }).ok).toBe(false);
    });

    it('accepts acyclic shared references', () => {
      const reg = new PayloadSchemaEngine();
      const schema = {
        $defs: { s: { type: 'string', pattern: '^[a-z]+$' }, n: { properties: { v: refTo('s') } } },
        properties: { a: refTo('n'), b: refTo('n'), c: refTo('s') },
      };
      expect(reg.validate('ok', schema, { a: { v: 'x' }, b: { v: 'y' }, c: 'z' })).toEqual({
        ok: true,
      });
      expect(reg.validate('ok', schema, { c: 'Z' }).ok).toBe(false);
    });
  });
});
