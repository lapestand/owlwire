import { MAX_PAYLOAD_SCHEMA_BYTES } from '@owlwire/contracts';
import type { ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';

export type SchemaCheck = { ok: true } | { ok: false; detail: string };

const DEFAULT_MAX_ENTRIES = 500;

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Compiles and runs payload schemas registered by apps (untrusted input).
 * Remote references are never fetched (no `loadSchema`), so they surface as
 * compile errors, and schema size is capped before anything is compiled.
 */
export class PayloadSchemaRegistry {
  readonly #ajv = new Ajv2020({
    strict: false,
    allErrors: false,
    addUsedSchema: false,
    validateSchema: true,
  });
  readonly #cache = new Map<string, ValidateFunction>();
  readonly #maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    this.#maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get size(): number {
    return this.#cache.size;
  }

  checkSchema(schema: unknown): SchemaCheck {
    const bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
    if (bytes > MAX_PAYLOAD_SCHEMA_BYTES) {
      return { ok: false, detail: `payloadSchema exceeds ${MAX_PAYLOAD_SCHEMA_BYTES} bytes` };
    }
    try {
      this.#ajv.compile(schema as Record<string, unknown>);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: messageOf(err) };
    }
  }

  validate(cacheKey: string, schema: Record<string, unknown>, data: unknown): SchemaCheck {
    let fn = this.#cache.get(cacheKey);
    if (fn) {
      this.#cache.delete(cacheKey);
    } else {
      try {
        fn = this.#ajv.compile(schema);
      } catch (err) {
        return { ok: false, detail: `payload schema cannot be compiled: ${messageOf(err)}` };
      }
    }
    this.#cache.set(cacheKey, fn);
    while (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
    if (fn(data)) return { ok: true };
    return {
      ok: false,
      detail: this.#ajv.errorsText(fn.errors, { dataVar: 'data', separator: '; ' }),
    };
  }
}
