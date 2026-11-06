/**
 * A logic-less template language: text with `{{ path }}` placeholders and nothing else.
 *
 * Templates are written by workspace admins and rendered on untrusted data, so the language is deliberately small:
 * no conditions, loops, helpers, filters or expressions, and a hand-written scanner instead of any evaluation. A path
 * walks only the data's own keys and never reaches the prototype chain.
 *
 * Path syntax: a plain first segment, then any mix of `.segment`, `[n]` and `["key"]`. Plain segments are
 * `[A-Za-z0-9_-]+`; inside a quoted key only `\"` and `\\` are escapes.
 */

export const MAX_TEMPLATE_LENGTH = 8000;

/** `invalid_template`: the template itself is wrong. `output_too_large`: rendering ran past its output budget. */
type TemplateErrorCode = 'invalid_template' | 'output_too_large';

export class TemplateError extends Error {
  override readonly name = 'TemplateError';
  /** Index in the template where the problem was found. */
  readonly position: number;
  readonly code: TemplateErrorCode;

  constructor(message: string, position: number, code: TemplateErrorCode = 'invalid_template') {
    super(`${message} at position ${position}`);
    this.position = position;
    this.code = code;
  }
}

type TemplatePart =
  | { t: 'text'; v: string; at: number }
  | { t: 'path'; segments: readonly string[]; at: number };

export type TemplateParse =
  | { ok: true; parts: readonly TemplatePart[] }
  | { ok: false; error: TemplateError };

const OPEN = '{{';
const CLOSE = '}}';
const PLAIN_CHAR = /[A-Za-z0-9_-]/;
const DIGIT = /[0-9]/;
const SPACE = /\s/;
const INDEX = /^(?:0|[1-9][0-9]*)$/;
const BLOCKED_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Signals that the input ended inside a placeholder; reported as an unclosed `{{`. */
class EndOfInput {}

class PathScanner {
  i: number;

  constructor(
    private readonly src: string,
    start: number,
  ) {
    this.i = start;
  }

  private peek(): string {
    if (this.i >= this.src.length) throw new EndOfInput();
    return this.src.charAt(this.i);
  }

  skipSpace(): void {
    while (SPACE.test(this.peek())) this.i += 1;
  }

  plain(): string {
    const start = this.i;
    while (PLAIN_CHAR.test(this.peek())) this.i += 1;
    if (this.i === start) throw new TemplateError('expected a path segment', start);
    return this.src.slice(start, this.i);
  }

  bracket(): string {
    // At `[`.
    this.i += 1;
    const ch = this.peek();
    let key: string;
    if (ch === '"') {
      key = this.quoted();
    } else if (DIGIT.test(ch)) {
      const start = this.i;
      while (DIGIT.test(this.peek())) this.i += 1;
      key = this.src.slice(start, this.i);
      if (!INDEX.test(key)) throw new TemplateError('invalid array index', start);
    } else {
      throw new TemplateError('expected an array index or a quoted key', this.i);
    }
    if (this.peek() !== ']') throw new TemplateError('expected "]"', this.i);
    this.i += 1;
    return key;
  }

  private quoted(): string {
    const open = this.i;
    this.i += 1;
    let key = '';
    for (;;) {
      if (this.i >= this.src.length) throw new TemplateError('unclosed quoted key', open);
      const ch = this.src.charAt(this.i);
      if (ch === '"') {
        this.i += 1;
        return key;
      }
      if (ch === '\\') {
        const next = this.src.charAt(this.i + 1);
        if (next !== '"' && next !== '\\')
          throw new TemplateError('invalid escape in quoted key', this.i);
        key += next;
        this.i += 2;
      } else {
        key += ch;
        this.i += 1;
      }
    }
  }

  /** Reads `path }}` and returns the segments; `i` ends just past `}}`. */
  placeholder(): string[] {
    this.skipSpace();
    const segments = [this.plain()];
    for (;;) {
      const ch = this.peek();
      if (ch === '.') {
        this.i += 1;
        segments.push(this.plain());
      } else if (ch === '[') {
        segments.push(this.bracket());
      } else {
        break;
      }
    }
    this.skipSpace();
    if (this.peek() !== '}' || this.src.charAt(this.i + 1) !== '}') {
      // A lone `}` at the very end means the input ran out before `}}`.
      if (this.i + 1 >= this.src.length) throw new EndOfInput();
      throw new TemplateError('only a path is allowed inside {{ }}', this.i);
    }
    this.i += CLOSE.length;
    return segments;
  }
}

export function parseTemplate(tpl: string): TemplateParse {
  if (tpl.length > MAX_TEMPLATE_LENGTH) {
    return {
      ok: false,
      error: new TemplateError(
        `template is longer than ${MAX_TEMPLATE_LENGTH} characters`,
        MAX_TEMPLATE_LENGTH,
      ),
    };
  }
  const parts: TemplatePart[] = [];
  let i = 0;
  while (i < tpl.length) {
    const open = tpl.indexOf(OPEN, i);
    if (open === -1) {
      parts.push({ t: 'text', v: tpl.slice(i), at: i });
      break;
    }
    if (open > i) parts.push({ t: 'text', v: tpl.slice(i, open), at: i });
    const scanner = new PathScanner(tpl, open + OPEN.length);
    try {
      parts.push({ t: 'path', segments: scanner.placeholder(), at: open });
    } catch (err) {
      if (err instanceof EndOfInput)
        return { ok: false, error: new TemplateError('unclosed {{', open) };
      if (err instanceof TemplateError) return { ok: false, error: err };
      throw err;
    }
    i = scanner.i;
  }
  return { ok: true, parts };
}

function lookup(data: unknown, segments: readonly string[]): unknown {
  let current = data;
  for (const segment of segments) {
    if (BLOCKED_SEGMENTS.has(segment)) return undefined;
    if (typeof current !== 'object' || current === null) return undefined;
    if (Array.isArray(current) && !INDEX.test(segment)) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function stringify(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'bigint':
      return String(value);
    case 'object': {
      if (value === null) return '';
      try {
        return JSON.stringify(value) ?? '';
      } catch {
        // Cycles or values JSON cannot encode: render nothing rather than fail the whole template.
        return '';
      }
    }
    default:
      return '';
  }
}

/**
 * Output budget and value cache shared by several renders on the same data. Each path is looked up and stringified
 * once per budget, and the renders together may write at most the budget's characters.
 */
class RenderBudget {
  private readonly values = new Map<string, string>();
  private data: unknown;

  constructor(private remaining: number) {}

  value(data: unknown, segments: readonly string[]): string {
    if (data !== this.data) {
      this.values.clear();
      this.data = data;
    }
    const key = JSON.stringify(segments);
    let text = this.values.get(key);
    if (text === undefined) {
      text = stringify(lookup(data, segments));
      this.values.set(key, text);
    }
    return text;
  }

  spend(text: string, at: number): void {
    if (text.length > this.remaining) {
      throw new TemplateError('rendered output exceeds its size limit', at, 'output_too_large');
    }
    this.remaining -= text.length;
  }
}

/** A budget of `maxLength` output characters for one or more `renderTemplateString` calls on the same data. */
export function createRenderBudget(maxLength: number): RenderBudget {
  return new RenderBudget(maxLength);
}

/**
 * Renders `tpl` on `data`; throws `TemplateError` when the template is invalid, or with code `output_too_large` as
 * soon as the output would pass the budget. Without a budget the output is limited only by the data.
 */
export function renderTemplateString(
  tpl: string,
  data: unknown,
  options: { budget?: RenderBudget } = {},
): string {
  const parsed = parseTemplate(tpl);
  if (!parsed.ok) throw parsed.error;
  const budget = options.budget ?? new RenderBudget(Number.POSITIVE_INFINITY);
  let out = '';
  for (const part of parsed.parts) {
    const text = part.t === 'text' ? part.v : budget.value(data, part.segments);
    budget.spend(text, part.at);
    out += text;
  }
  return out;
}
