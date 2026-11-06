import type { EventInput } from '@owlwire/contracts';
import type { CatalogTypeRow } from '@owlwire/db';
import { afterAll, describe, expect, it } from 'vitest';
import { ProblemError } from '../errors.js';
import { prepareEvent, resolveIdempotencyKey } from './ingest.js';
import { PayloadSchemaRegistry, type SchemaCheck } from './payload-schema.js';

const updatedAt = new Date('2026-10-01T00:00:00Z');
const ct = (key: string, extra: Partial<CatalogTypeRow> = {}): CatalogTypeRow => ({
  appId: 'app-1',
  key,
  name: key,
  description: null,
  defaultSeverity: 'info',
  payloadSchema: null,
  updatedAt,
  ...extra,
});
const catalog = new Map<string, CatalogTypeRow>([
  ['generic', ct('generic')],
  ['account.inactive', ct('account.inactive', { defaultSeverity: 'high' })],
  [
    'attack.incoming',
    ct('attack.incoming', {
      payloadSchema: {
        type: 'object',
        required: ['target'],
        properties: { target: { type: 'string' } },
      },
    }),
  ],
]);
const principal = {
  installationId: 'inst-1',
  workspaceId: 'ws-1',
  appId: 'app-1',
  grantedTypes: null,
};
const schemas = new PayloadSchemaRegistry();
let counter = 0;
const gen = () => `gen-${++counter}`;
const prep = (
  input: EventInput,
  opts: { header?: string; granted?: string[] | null; registry?: PayloadSchemaRegistry } = {},
) =>
  prepareEvent(
    input,
    { ...principal, grantedTypes: opts.granted ?? null },
    catalog,
    opts.registry ?? schemas,
    opts.header,
    gen,
  );

/** A registry whose validate always answers `result` (to reach failure modes without real cost). */
function fixedRegistry(result: SchemaCheck): PayloadSchemaRegistry {
  return { validate: () => Promise.resolve(result) } as unknown as PayloadSchemaRegistry;
}

afterAll(async () => {
  await schemas.close();
});

describe('resolveIdempotencyKey', () => {
  it('prefers the body key, then the header, then a generated key', () => {
    expect(resolveIdempotencyKey('b', undefined, gen)).toEqual({ ok: true, key: 'b' });
    expect(resolveIdempotencyKey(undefined, 'h', gen)).toEqual({ ok: true, key: 'h' });
    expect(resolveIdempotencyKey('same', 'same', gen)).toEqual({ ok: true, key: 'same' });
    expect(resolveIdempotencyKey(undefined, undefined, () => 'g')).toEqual({ ok: true, key: 'g' });
  });

  it('rejects conflicting body and header keys', () => {
    expect(resolveIdempotencyKey('a', 'b', gen).ok).toBe(false);
  });

  it('treats blank keys as absent and trims keys', () => {
    expect(resolveIdempotencyKey('   ', 'h', gen)).toEqual({ ok: true, key: 'h' });
    expect(resolveIdempotencyKey(' k ', 'k', gen)).toEqual({ ok: true, key: 'k' });
    expect(resolveIdempotencyKey('  ', undefined, () => 'g2')).toEqual({ ok: true, key: 'g2' });
  });
});

describe('prepareEvent', () => {
  it('rejects types missing from the catalog', async () => {
    expect(await prep({ type: 'city.lost', body: 'x' })).toMatchObject({
      ok: false,
      code: 'unknown_type',
    });
  });

  it('rejects types not granted to the installation', async () => {
    const r = await prep({ type: 'account.inactive', body: 'x' }, { granted: ['generic'] });
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
  });

  it('checks the catalog before the grant', async () => {
    const r = await prep({ type: 'city.lost', body: 'x' }, { granted: ['generic'] });
    expect(r).toMatchObject({ ok: false, code: 'unknown_type' });
  });

  it('validates data against the payload schema, treating missing data as {}', async () => {
    expect(await prep({ type: 'attack.incoming', body: 'x' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    const ok = await prep({ type: 'attack.incoming', body: 'x', data: { target: 'city' } });
    expect(ok.ok).toBe(true);
  });

  it('checks the payload schema before the idempotency keys', async () => {
    const r = await prep(
      { type: 'attack.incoming', body: 'x', idempotencyKey: 'a' },
      { header: 'b' },
    );
    expect(r).toMatchObject({ ok: false, code: 'validation_failed' });
    expect(r.ok === false && r.detail).not.toMatch(/Idempotency-Key/);
  });

  it('defaults severity from the catalog and then to info', async () => {
    const fromCatalog = await prep({ type: 'account.inactive', body: 'x' });
    const fallback = await prep({ type: 'generic', body: 'x' });
    const explicit = await prep({ type: 'account.inactive', body: 'x', severity: 'low' });
    expect(fromCatalog.ok && fromCatalog.row.severity).toBe('high');
    expect(fallback.ok && fallback.row.severity).toBe('info');
    expect(explicit.ok && explicit.row.severity).toBe('low');
  });

  it('stores the message without the idempotency key', async () => {
    const r = await prep({ type: 'generic', body: 'hello', title: 'T', idempotencyKey: 'k-1' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.row).toEqual({
        installationId: 'inst-1',
        idempotencyKey: 'k-1',
        type: 'generic',
        severity: 'info',
        message: { type: 'generic', severity: 'info', body: 'hello', title: 'T' },
      });
    }
  });

  it('rejects conflicting idempotency keys', async () => {
    const r = await prep({ type: 'generic', body: 'x', idempotencyKey: 'a' }, { header: 'b' });
    expect(r).toMatchObject({ ok: false, code: 'validation_failed' });
  });

  it('reports a payload too expensive to validate as an invalid event', async () => {
    const registry = fixedRegistry({ ok: false, detail: 'payload too expensive to validate' });
    const r = await prep({ type: 'attack.incoming', body: 'x' }, { registry });
    expect(r).toEqual({
      ok: false,
      code: 'validation_failed',
      detail: 'payload too expensive to validate',
    });
  });

  it.each(['payload validator is busy', 'payload validator is closed'])(
    'answers "%s" with a retryable 503, not an invalid event',
    async (detail) => {
      const registry = fixedRegistry({ ok: false, detail });
      const err = await prep({ type: 'attack.incoming', body: 'x' }, { registry }).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(ProblemError);
      expect(err).toMatchObject({ status: 503, code: 'unavailable' });
      expect((err as ProblemError).headers).toEqual({ 'retry-after': '1' });
    },
  );

  it('does not call the validator for types without a payload schema', async () => {
    const registry = fixedRegistry({ ok: false, detail: 'payload validator is busy' });
    expect((await prep({ type: 'generic', body: 'x' }, { registry })).ok).toBe(true);
  });
});
