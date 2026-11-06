import { MAX_PAYLOAD_SCHEMA_BYTES } from '@owlwire/contracts';
import type { ValidateFunction } from 'ajv';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { RE2JS } from 're2js';

export type SchemaCheck = { ok: true } | { ok: false; detail: string };

const DEFAULT_MAX_ENTRIES = 500;
// Only formats error text and never compiles a schema, so it retains nothing.
const TEXT_FORMATTER = new Ajv2020({ logger: false });

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const MAX_PATTERN_LENGTH = 512;
const MAX_REPEAT_BOUND = 100;
const REPEAT_BOUNDS = /\{(\d+)(?:,(\d*))?\}/g;

/**
 * A linear-time engine is still O(input x program size), and large counted repetitions blow
 * the program up, so long patterns and big repeat bounds are refused outright. The bound scan
 * is textual: a brace group inside a character class is refused too, which fails closed.
 */
function assertAffordable(pattern: string): void {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  for (const m of pattern.matchAll(REPEAT_BOUNDS)) {
    for (const bound of [m[1], m[2]]) {
      if (bound && Number(bound) > MAX_REPEAT_BOUND) {
        throw new Error(`pattern repetition bound exceeds ${MAX_REPEAT_BOUND}`);
      }
    }
  }
}

/**
 * Schema patterns come from untrusted apps and run against every ingested event, so they use
 * a linear-time engine instead of the backtracking native RegExp. Patterns it cannot express
 * (backreferences, lookaround) throw here, which makes the schema fail to compile.
 */
function linearRegExp(pattern: string): { test: (s: string) => boolean; toString: () => string } {
  assertAffordable(pattern);
  const re = RE2JS.compile(pattern);
  // Ajv keys its compiled-pattern scope by toString(), so it must identify the pattern.
  return { test: (s) => re.test(s), toString: () => pattern };
}
// Not 'new RegExp': that marker makes Ajv emit a native RegExp in generated code.
linearRegExp.code = 're2js-linear';

/**
 * Compiles and runs payload schemas registered by apps (untrusted input).
 * Remote references are never fetched (no `loadSchema`), so they surface as
 * compile errors, and schema size is capped before anything is compiled.
 */
export class PayloadSchemaRegistry {
  readonly #cache = new Map<string, ValidateFunction>();
  readonly #maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    this.#maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  get size(): number {
    return this.#cache.size;
  }

  /**
   * Every compile gets its own Ajv instance. Ajv retains each compiled schema, pattern and
   * program in instance-level caches that cannot be bounded, so a shared instance would grow
   * forever; a throwaway instance is collected together with its caches, leaving this
   * registry's LRU as the only thing that keeps compiled validators alive.
   */
  #compile(schema: Record<string, unknown>): ValidateFunction {
    const ajv = new Ajv2020({
      strict: false,
      allErrors: false,
      addUsedSchema: false,
      validateSchema: true,
      // Refs are never inlined: inlining a shared definition at every use multiplies the
      // generated code and can stall the event loop for tens of seconds on a small schema.
      inlineRefs: false,
      // Schemas are untrusted and must not write to the console (unknown formats warn).
      logger: false,
      code: { regExp: linearRegExp },
    });
    return ajv.compile(schema);
  }

  checkSchema(schema: unknown): SchemaCheck {
    const bytes = new TextEncoder().encode(JSON.stringify(schema)).byteLength;
    if (bytes > MAX_PAYLOAD_SCHEMA_BYTES) {
      return { ok: false, detail: `payloadSchema exceeds ${MAX_PAYLOAD_SCHEMA_BYTES} bytes` };
    }
    try {
      this.#compile(schema as Record<string, unknown>);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: messageOf(err) };
    }
  }

  /** Never throws: any compile or runtime failure is reported as an invalid result. */
  validate(cacheKey: string, schema: Record<string, unknown>, data: unknown): SchemaCheck {
    let fn = this.#cache.get(cacheKey);
    if (fn) {
      this.#cache.delete(cacheKey);
    } else {
      try {
        fn = this.#compile(schema);
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
    try {
      if (fn(data)) return { ok: true };
    } catch (err) {
      const deep = err instanceof RangeError;
      return {
        ok: false,
        detail: deep
          ? 'payload is nested too deeply'
          : `payload cannot be validated: ${messageOf(err)}`,
      };
    }
    return { ok: false, detail: errorsText(fn.errors) };
  }
}

function errorsText(errors: ValidateFunction['errors']): string {
  return TEXT_FORMATTER.errorsText(errors, { dataVar: 'data', separator: '; ' });
}
