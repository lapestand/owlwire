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
});
