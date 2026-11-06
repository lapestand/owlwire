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
const MAX_REPEAT_PRODUCT = 100;
const MAX_PATTERN_COST = 2500; // estimated program size, summed over all patterns of a schema
const MAX_PATTERNS_PER_SCHEMA = 32;
const MAX_STRING_FOR_PATTERN = 4096;
const BOUNDS = /^\{(\d+)(?:,(\d*))?\}/;

/** Raised while validating when a string is too long to be matched safely. */
class PatternInputError extends Error {}

/** Raised while validating when the call has used up its regex budget. */
class BudgetExceededError extends Error {}

const MAX_REFS_PER_SCHEMA = 16;

/**
 * Regex work allowed in one validate() call. The unit is (string length x the pattern's cost
 * estimate) summed over every pattern test; the worst matching rate measured for patterns
 * that pass the compile-time limits is about 65000 units per millisecond, so this is roughly
 * 200 ms of matching. The compile-time limits bound one test; this bounds how often a schema
 * can make the engine run one (arrays, many properties, shared definitions behind `$ref`).
 */
const MAX_VALIDATION_BUDGET = 13_000_000;

// validate() is synchronous, so one module-level slot per call is not shared between calls.
let activeBudget: { spent: number } | null = null;

/**
 * Upper bound of a quantifier at the start of `rest`, with its length, or null. `{n}` counts
 * as n, `{n,}` as n and `{n,m}` as m; `*`, `+` and `?` do not enlarge the program.
 */
function quantifierAt(rest: string): { bound: number; length: number } | null {
  const c = rest[0];
  if (c === '*' || c === '+' || c === '?') return { bound: 1, length: 1 };
  const m = BOUNDS.exec(rest);
  if (!m) return null;
  const [text, lo, hi] = m;
  const bounds = [lo, hi].filter((v): v is string => !!v).map(Number);
  if (bounds.some((n) => n > MAX_REPEAT_BOUND)) {
    throw new Error(`pattern repetition bound exceeds ${MAX_REPEAT_BOUND}`);
  }
  return { bound: Math.max(1, hi ? Number(hi) : Number(lo)), length: text.length };
}

/**
 * Walks the pattern text and refuses it when nested counted repetitions multiply beyond
 * MAX_REPEAT_PRODUCT, or when the estimated program size (every atom weighted by the
 * repetitions around it) exceeds MAX_PATTERN_COST. Each frame tracks the largest repetition
 * product and the summed cost inside one group.
 */
function assertNestedBounds(pattern: string): number {
  const frames = [{ product: 1, cost: 0 }];
  const top = () => frames[frames.length - 1] ?? { product: 1, cost: 0 };
  const note = (product: number, cost: number): void => {
    if (product > MAX_REPEAT_PRODUCT) {
      throw new Error(`pattern nested repetition exceeds ${MAX_REPEAT_PRODUCT}`);
    }
    const frame = top();
    frame.product = Math.max(frame.product, product);
    frame.cost += cost;
    if (frames.length === 1 && frame.cost > MAX_PATTERN_COST) {
      throw new Error('pattern is too complex');
    }
  };
  const atom = (at: number): number => {
    const q = quantifierAt(pattern.slice(at));
    note(q?.bound ?? 1, q?.bound ?? 1);
    return at + (q?.length ?? 0);
  };
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === '\\') {
      i = atom(i + 2);
    } else if (c === '[') {
      // Character class: skip to the closing bracket, honouring escapes and a leading ].
      i += 1;
      if (pattern[i] === '^') i += 1;
      if (pattern[i] === ']') i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i = atom(i + 1);
    } else if (c === '(') {
      frames.push({ product: 1, cost: 0 });
      i += 1;
    } else if (c === ')') {
      const inner = frames.length > 1 ? (frames.pop() ?? top()) : { product: 1, cost: 0 };
      const q = quantifierAt(pattern.slice(i + 1));
      const bound = q?.bound ?? 1;
      i += 1 + (q?.length ?? 0);
      note(inner.product * bound, Math.max(1, inner.cost) * bound);
    } else {
      i = atom(i + 1);
    }
  }
  return frames[0]?.cost ?? 0;
}

/**
 * A linear-time engine is still O(input x program size), and large counted repetitions blow
 * the program up, so long patterns, big repeat bounds and nested repetitions are refused
 * outright. The scan is textual and fails closed.
 */
function assertAffordable(pattern: string): number {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
  }
  // Quoted text (Q..E) would hide repetitions from the scan below, so it is refused.
  if (pattern.includes('\\Q')) throw new Error('pattern must not use \\Q');
  return assertNestedBounds(pattern);
}

/**
 * Builds the regex factory handed to Ajv for one compile. Schema patterns come from untrusted
 * apps and run against every ingested event, so they use a linear-time engine instead of the
 * backtracking native RegExp. Patterns it cannot express (backreferences, lookaround) throw
 * here, which makes the schema fail to compile, as does having too many patterns. Strings
 * longer than MAX_STRING_FOR_PATTERN are never matched: validation fails instead.
 */
function linearRegExpFactory(): {
  (pattern: string): { test: (s: string) => boolean; toString: () => string };
  code: string;
  arm: () => void;
} {
  let count = 0;
  let armed = false;
  let totalCost = 0;
  const factory = (pattern: string) => {
    if (armed) count += 1;
    if (count > MAX_PATTERNS_PER_SCHEMA) {
      throw new Error(`schema has more than ${MAX_PATTERNS_PER_SCHEMA} patterns`);
    }
    const cost = assertAffordable(pattern);
    if (armed) {
      totalCost += cost;
      if (totalCost > MAX_PATTERN_COST) throw new Error('schema patterns are too complex');
    }
    const unit = Math.max(1, cost);
    const re = RE2JS.compile(pattern);
    return {
      test: (s: string) => {
        if (s.length > MAX_STRING_FOR_PATTERN) {
          throw new PatternInputError('string too long for pattern');
        }
        if (activeBudget) {
          activeBudget.spent += s.length * unit;
          if (activeBudget.spent > MAX_VALIDATION_BUDGET) {
            throw new BudgetExceededError('payload too expensive to validate');
          }
        }
        return re.test(s);
      },
      // Ajv keys its compiled-pattern scope by toString(), so it must identify the pattern.
      toString: () => pattern,
    };
  };
  // Not 'new RegExp': that marker makes Ajv emit a native RegExp in generated code.
  factory.code = 're2js-linear';
  // Counting starts once Ajv has compiled its own meta-schemas, which contain patterns too.
  factory.arm = () => {
    armed = true;
  };
  return factory;
}

type SchemaNode = Record<string, unknown>;

function isNode(v: unknown): v is SchemaNode {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function children(node: unknown): unknown[] {
  if (Array.isArray(node)) return node;
  return isNode(node) ? Object.values(node) : [];
}

/** Resolves a local `#` or `#/json/pointer` reference (the only form assertRefsAffordable allows). */
function resolveLocalRef(root: unknown, ref: string): unknown {
  const fragment = ref.slice(1);
  let node: unknown = root;
  if (fragment === '') return node;
  for (const raw of fragment.slice(1).split('/')) {
    const key = decodeURIComponent(raw).replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(node)) node = node[Number(key)];
    else if (isNode(node)) node = node[key];
    else return undefined;
  }
  return node;
}

/**
 * Refuses schemas with more than MAX_REFS_PER_SCHEMA references, with dynamic references, with
 * any `$ref` that is not a local JSON pointer, with a nested `$id` or any anchor, or with a
 * reference that can reach itself. Every `$ref` is a place where one validation can run
 * the same subschema again, so the count and the absence of cycles keep that fan-out small.
 */
function assertRefsAffordable(root: unknown): void {
  const refs = new Map<object, string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (isNode(node)) {
      if ('$dynamicRef' in node || '$recursiveRef' in node) {
        throw new Error('dynamic references are not supported');
      }
      // A nested `$id` or an anchor gives a subschema a second name that a `$ref` can reach
      // without a JSON pointer, which would hide cycles from the check below.
      if (node !== root && typeof node.$id === 'string') {
        throw new Error('$id is only supported at the schema root');
      }
      for (const keyword of ['$anchor', '$dynamicAnchor']) {
        if (typeof node[keyword] === 'string') throw new Error(`${keyword} is not supported`);
      }
      if (typeof node.$ref === 'string') {
        if (node.$ref !== '#' && !node.$ref.startsWith('#/')) {
          throw new Error('$ref must be a local JSON pointer starting with #');
        }
        refs.set(node, node.$ref);
      }
    }
    stack.push(...children(node));
  }
  if (refs.size > MAX_REFS_PER_SCHEMA) {
    throw new Error(`schema has more than ${MAX_REFS_PER_SCHEMA} $ref references`);
  }
  const refsWithin = (start: unknown): object[] => {
    const found: object[] = [];
    const todo: unknown[] = [start];
    while (todo.length > 0) {
      const node = todo.pop();
      if (isNode(node) && refs.has(node)) found.push(node);
      todo.push(...children(node));
    }
    return found;
  };
  const edges = new Map<object, object[]>();
  for (const [node, ref] of refs) {
    const target = resolveLocalRef(root, ref);
    edges.set(node, target === undefined ? [] : refsWithin(target));
  }
  const state = new Map<object, 'open' | 'done'>();
  const visit = (node: object): void => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'open') throw new Error('schema has a cyclic $ref');
    state.set(node, 'open');
    for (const next of edges.get(node) ?? []) visit(next);
    state.set(node, 'done');
  };
  for (const node of refs.keys()) visit(node);
}

/**
 * Compiles and runs payload schemas registered by apps (untrusted input), synchronously.
 * Remote references are never fetched (no `loadSchema`). The static limits here are the
 * first line of defence only; nothing bounds total evaluation time, so this runs inside the
 * worker threads of PayloadSchemaRegistry, which enforce a deadline per call.
 */
export class PayloadSchemaEngine {
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
   * engine's LRU as the only thing that keeps compiled validators alive.
   */
  #compile(schema: Record<string, unknown>): ValidateFunction {
    assertRefsAffordable(schema);
    const regExp = linearRegExpFactory();
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
      code: { regExp },
    });
    ajv.validateSchema({});
    regExp.arm();
    return ajv.compile(schema);
  }

  /** The caller checks the schema size first (PayloadSchemaRegistry does). */
  checkSchema(schema: unknown): SchemaCheck {
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
    activeBudget = { spent: 0 };
    try {
      if (fn(data)) return { ok: true };
    } catch (err) {
      if (err instanceof PatternInputError || err instanceof BudgetExceededError) {
        return { ok: false, detail: err.message };
      }
      const deep = err instanceof RangeError;
      return {
        ok: false,
        detail: deep
          ? 'payload is nested too deeply'
          : `payload cannot be validated: ${messageOf(err)}`,
      };
    } finally {
      activeBudget = null;
    }
    return { ok: false, detail: errorsText(fn.errors) };
  }
}

function errorsText(errors: ValidateFunction['errors']): string {
  return TEXT_FORMATTER.errorsText(errors, { dataVar: 'data', separator: '; ' });
}
