import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { PayloadSchemaRegistry } from './payload-schema.js';

const schema = {
  type: 'object',
  required: ['target'],
  properties: { target: { type: 'string' }, count: { type: 'integer', minimum: 0 } },
};

const TOO_EXPENSIVE = { ok: false, detail: 'payload too expensive to validate' };

// Workers take a moment to start, so most tests share one registry.
const reg = new PayloadSchemaRegistry();
afterAll(() => reg.close());

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - started };
}

/** The attacks measured against the static limits alone (each took 6 to 51 s). */
const attacks = {
  idCycle: {
    schema: {
      $defs: {
        a: {
          $id: 'urn:x:a',
          type: 'array',
          items: { allOf: [{ $ref: 'urn:x:a' }, { $ref: 'urn:x:a' }] },
        },
      },
      $ref: 'urn:x:a',
    },
    data: (() => {
      let deep: unknown = [];
      for (let i = 0; i < 30; i++) deep = [deep];
      return deep;
    })(),
  },
  uniqueItems: {
    schema: { allOf: Array.from({ length: 727 }, () => ({ uniqueItems: true })) },
    data: Array.from({ length: 2000 }, (_, i) => [i]),
  },
  refFanOut: {
    schema: (() => {
      const four = (name: string) => ({
        allOf: [0, 1, 2, 3].map(() => ({ $ref: `#/$defs/${name}` })),
      });
      return {
        $defs: { l1: four('l2'), l2: four('l3'), l3: four('u'), u: { uniqueItems: true } },
        ...four('l1'),
      };
    })(),
    data: Array.from({ length: 2000 }, (_, i) => [i]),
  },
};

describe('PayloadSchemaRegistry', () => {
  it('accepts a valid JSON Schema', async () => {
    expect(await reg.checkSchema(schema)).toEqual({ ok: true });
  });

  it('rejects an invalid JSON Schema with a readable detail', async () => {
    const r = await reg.checkSchema({ type: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/type/);
  });

  it('rejects remote references', async () => {
    expect((await reg.checkSchema({ $ref: 'https://example.com/s.json' })).ok).toBe(false);
  });

  it('rejects schemas larger than 16384 bytes', async () => {
    const r = await reg.checkSchema({ type: 'object', description: 'x'.repeat(17_000) });
    expect(r).toEqual({ ok: false, detail: 'payloadSchema exceeds 16384 bytes' });
  });

  it('rejects a schema that is not JSON', async () => {
    expect(await reg.checkSchema({ n: 1n })).toEqual({
      ok: false,
      detail: 'payloadSchema is not JSON',
    });
  });

  it('allows two apps to use the same $id', async () => {
    const withId = { ...schema, $id: 'https://tracker.example/event.json' };
    expect(await reg.validate('app1:t:1', withId, { target: 'x' })).toEqual({ ok: true });
    expect(await reg.validate('app2:t:1', withId, { target: 'y' })).toEqual({ ok: true });
  });

  it('validates data and reports the failing path', async () => {
    const r = await reg.validate('a:t:1', schema, { target: 'x', count: -1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toContain('data/count');
  });

  it('reuses the compiled validator for a cache key', async () => {
    // The cache is keyed, not content-addressed: a key keeps the schema it was compiled with.
    const one = new PayloadSchemaRegistry({ poolSize: 1 });
    try {
      expect(await one.validate('k', { type: 'string' }, 'x')).toEqual({ ok: true });
      expect(await one.validate('k', { type: 'number' }, 'x')).toEqual({ ok: true });
      expect((await one.validate('k2', { type: 'number' }, 'x')).ok).toBe(false);
    } finally {
      await one.close();
    }
  });

  it('reports a payload that cannot be passed to a worker', async () => {
    const r = await reg.validate('fn', { type: 'object' }, { f: () => 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/^payload cannot be validated/);
    expect(await reg.validate('fn', { type: 'object' }, {})).toEqual({ ok: true });
  });

  it('still validates patterns on the linear engine', async () => {
    const s = { type: 'string', pattern: '^(a+)+$' };
    const { result, ms } = await timed(() => reg.validate('evil', s, `${'a'.repeat(50)}b`));
    expect(result.ok).toBe(false);
    expect(result).not.toEqual(TOO_EXPENSIVE);
    expect(ms).toBeLessThan(1000);
  });

  describe('evaluation deadline', () => {
    it('refuses the recursive $id schema statically and quickly', async () => {
      const { schema: s, data } = attacks.idCycle;
      expect((await reg.checkSchema(s)).ok).toBe(false);
      const { result, ms } = await timed(() => reg.validate('id-cycle', s, data));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.detail).toMatch(/^payload schema cannot be compiled/);
      expect(ms).toBeLessThan(1000);
    });

    it('stops inline allOf copies of uniqueItems at the deadline', async () => {
      const { schema: s, data } = attacks.uniqueItems;
      const { result, ms } = await timed(() => reg.validate('unique', s, data));
      expect(result).toEqual(TOO_EXPENSIVE);
      expect(ms).toBeLessThan(1000);
    });

    it('refuses a schema whose compile misses the deadline', async () => {
      // 727 inline branches take about 400 ms to compile.
      const { result, ms } = await timed(() => reg.checkSchema(attacks.uniqueItems.schema));
      expect(result).toEqual({ ok: false, detail: 'payloadSchema too expensive to compile' });
      expect(ms).toBeLessThan(1000);
    });

    it('stops a 4x4 ref fan-out at the deadline', async () => {
      const { schema: s, data } = attacks.refFanOut;
      expect(await reg.checkSchema(s)).toEqual({ ok: true });
      const { result, ms } = await timed(() => reg.validate('fan', s, data));
      expect(result).toEqual(TOO_EXPENSIVE);
      expect(ms).toBeLessThan(1000);
    });

    it('replaces a timed out worker so the next call works', async () => {
      const one = new PayloadSchemaRegistry({ poolSize: 1 });
      try {
        const { schema: s, data } = attacks.refFanOut;
        expect(await one.validate('fan', s, data)).toEqual(TOO_EXPENSIVE);
        expect(await one.validate('fan', s, data)).toEqual(TOO_EXPENSIVE);
        expect(await one.validate('ok', schema, { target: 'x' })).toEqual({ ok: true });
        expect((await one.validate('bad', schema, {})).ok).toBe(false);
      } finally {
        await one.close();
      }
    });

    it('keeps the main event loop free while a worker is busy', async () => {
      const one = new PayloadSchemaRegistry({ poolSize: 1 });
      try {
        await one.validate('warm', schema, { target: 'x' });
        let ticks = 0;
        const timer = setInterval(() => ticks++, 10);
        const { schema: s, data } = attacks.uniqueItems;
        expect(await one.validate('unique', s, data)).toEqual(TOO_EXPENSIVE);
        clearInterval(timer);
        expect(ticks).toBeGreaterThanOrEqual(10);
      } finally {
        await one.close();
      }
    });
  });

  describe('pool', () => {
    it('gives correct independent results to parallel calls', async () => {
      const cases = Array.from({ length: 12 }, (_, i) => {
        const s = { type: 'object', required: [`p${i}`], properties: { [`p${i}`]: { const: i } } };
        const valid = i % 2 === 0;
        return { key: `par${i}`, s, data: { [`p${i}`]: valid ? i : -1 }, valid };
      });
      const results = await Promise.all(cases.map((c) => reg.validate(c.key, c.s, c.data)));
      expect(results.map((r) => r.ok)).toEqual(cases.map((c) => c.valid));
    });

    it('keeps other calls correct while one call times out', async () => {
      const { schema: s, data } = attacks.uniqueItems;
      const [slow, ...rest] = await Promise.all([
        reg.validate('slow', s, data),
        ...Array.from({ length: 6 }, (_, i) =>
          reg.validate(`fast${i}`, schema, i % 2 ? { target: 'x' } : {}),
        ),
      ]);
      expect(slow).toEqual(TOO_EXPENSIVE);
      expect(rest.map((r) => r.ok)).toEqual([false, true, false, true, false, true]);
    });

    it('fails closed when the queue is full', async () => {
      const one = new PayloadSchemaRegistry({ poolSize: 1, maxQueued: 1 });
      try {
        await one.validate('warm', schema, { target: 'x' });
        const { schema: s, data } = attacks.uniqueItems;
        const running = one.validate('slow', s, data);
        const queued = one.validate('ok', schema, { target: 'x' });
        expect(await one.validate('ok', schema, { target: 'x' })).toEqual({
          ok: false,
          detail: 'payload validator is busy',
        });
        expect(await running).toEqual(TOO_EXPENSIVE);
        expect(await queued).toEqual({ ok: true });
      } finally {
        await one.close();
      }
    });

    it('resolves pending and later calls after close()', async () => {
      const one = new PayloadSchemaRegistry({ poolSize: 1 });
      const pending = one.validate('a', schema, { target: 'x' });
      await one.close();
      const closed = { ok: false, detail: 'payload validator is closed' };
      expect(await pending).toEqual(closed);
      expect(await one.validate('a', schema, { target: 'x' })).toEqual(closed);
      expect(await one.checkSchema(schema)).toEqual(closed);
    });

    it('does not keep the process alive, before or after close()', () => {
      const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
      const module = pathToFileURL(fileURLToPath(new URL('./payload-schema.ts', import.meta.url)));
      for (const close of [true, false]) {
        const code = [
          `const { PayloadSchemaRegistry } = await import(${JSON.stringify(module.href)});`,
          'const reg = new PayloadSchemaRegistry();',
          "const r = await reg.validate('k', { type: 'string' }, 'x');",
          close ? 'await reg.close();' : '',
          'console.log(JSON.stringify(r));',
        ].join('\n');
        const started = performance.now();
        const child = spawnSync(
          process.execPath,
          ['--conditions=source', '--import', tsx, '--input-type=module', '-e', code],
          { encoding: 'utf8', timeout: 20_000 },
        );
        expect(child.stderr).toBe('');
        expect(child.status, `close=${close}`).toBe(0);
        expect(child.stdout.trim()).toBe('{"ok":true}');
        expect(performance.now() - started).toBeLessThan(20_000);
      }
    });
  });
});
