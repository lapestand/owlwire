/**
 * Source templates turn an incoming webhook body into an event: every text field of the mapping is a template
 * rendered on `{ payload, headers }`. Pure and deterministic, so it can run anywhere the body is available.
 */
import { z } from 'zod';
import { isSeverity, SEVERITIES, type Severity } from './message.js';
import {
  createRenderBudget,
  parseTemplate,
  renderTemplateString,
  TemplateError,
} from './template.js';

export const SOURCE_TEMPLATE_ROOTS = ['payload', 'headers'] as const;

/** The most fields an event may carry; matches the event input limit. */
const MAX_FIELDS = 20;

/** The most characters one mapping may render across all its fields, so a template cannot amplify a payload. */
const MAX_RENDERED_OUTPUT = 65536;

const templateText = z.string().superRefine((text, ctx) => {
  const parsed = parseTemplate(text);
  if (!parsed.ok) {
    ctx.addIssue({ code: 'custom', message: parsed.error.message });
    return;
  }
  for (const part of parsed.parts) {
    if (part.t !== 'path') continue;
    const root = part.segments[0] ?? '';
    if (!(SOURCE_TEMPLATE_ROOTS as readonly string[]).includes(root)) {
      ctx.addIssue({
        code: 'custom',
        message: `unknown template root "${root}"; paths start with ${SOURCE_TEMPLATE_ROOTS.join(' or ')}`,
      });
      return;
    }
  }
});

const severity = z.enum(SEVERITIES);

export const SourceTemplateMappingSchema = z
  .object({
    type: templateText,
    severity: z
      .object({
        from: templateText.optional(),
        map: z.record(z.string(), severity).optional(),
        default: severity.optional(),
      })
      .strict()
      .optional(),
    title: templateText.optional(),
    body: templateText,
    fields: z
      .array(
        z
          .object({ label: templateText, value: templateText, inline: z.boolean().optional() })
          .strict(),
      )
      .max(MAX_FIELDS)
      .optional(),
    url: templateText.optional(),
    imageUrl: templateText.optional(),
    groupKey: templateText.optional(),
    summary: templateText.optional(),
    idempotencyKey: templateText.optional(),
  })
  .strict();

export type SourceTemplateMapping = z.infer<typeof SourceTemplateMappingSchema>;

/** The structural subset of the event input that a source template produces. */
export interface EventInputLike {
  type: string;
  severity?: Severity;
  title?: string;
  body: string;
  fields?: Array<{ label: string; value: string; inline?: boolean }>;
  url?: string;
  imageUrl?: string;
  groupKey?: string;
  summary?: string;
  idempotencyKey?: string;
  data?: Record<string, unknown>;
}

/** The root templates render on: the parsed body and the request headers that are safe to show. */
export interface SourceTemplateContext {
  payload: unknown;
  headers: Readonly<Record<string, string>>;
}

const SECRET_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'proxy-authorization',
]);
const SECRET_HEADER_PARTS = [
  'token',
  'secret',
  'signature',
  'key',
  'auth',
  'password',
  'credential',
  'hmac',
] as const;

/**
 * Picks the request headers templates may see: names lower-cased, credentials and anything whose name mentions a
 * token, secret, signature, key, auth, password, credential or hmac left out, repeated names joined with `, `.
 */
export function selectTemplateHeaders(
  entries: Iterable<readonly [string, string]>,
): Record<string, string> {
  const kept = new Map<string, string>();
  for (const [rawName, value] of entries) {
    const name = rawName.toLowerCase();
    if (SECRET_HEADERS.has(name) || SECRET_HEADER_PARTS.some((part) => name.includes(part)))
      continue;
    const previous = kept.get(name);
    kept.set(name, previous === undefined ? value : `${previous}, ${value}`);
  }
  // fromEntries defines own properties, so a header named `__proto__` stays plain data.
  return Object.fromEntries(kept);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

type OptionalTextKey = 'title' | 'url' | 'imageUrl' | 'groupKey' | 'summary' | 'idempotencyKey';
const OPTIONAL_TEXT_KEYS: readonly OptionalTextKey[] = [
  'title',
  'url',
  'imageUrl',
  'groupKey',
  'summary',
  'idempotencyKey',
];

/**
 * Renders `mapping` on `ctx` and collects every problem by path. Throws `TemplateError` with code `output_too_large`
 * once the rendered fields together pass the output limit.
 */
export function applySourceTemplate(
  mapping: SourceTemplateMapping,
  ctx: SourceTemplateContext,
):
  | { ok: true; event: EventInputLike }
  | { ok: false; errors: Array<{ path: string; message: string }> } {
  const errors: Array<{ path: string; message: string }> = [];
  const root = { payload: ctx.payload, headers: ctx.headers };
  const budget = createRenderBudget(MAX_RENDERED_OUTPUT);
  const render = (tpl: string, path: string): string => {
    try {
      return renderTemplateString(tpl, root, { budget });
    } catch (err) {
      // Running out of output budget aborts the whole mapping; only invalid templates are collected.
      if (!(err instanceof TemplateError) || err.code === 'output_too_large') throw err;
      errors.push({ path, message: err.message });
      return '';
    }
  };

  const required = (key: 'type' | 'body'): string => {
    const before = errors.length;
    const text = render(mapping[key], key);
    if (text === '' && errors.length === before)
      errors.push({ path: key, message: `${key} rendered empty` });
    return text;
  };

  const type = required('type');
  const body = required('body');
  const event: EventInputLike = { type, body };

  const resolvedSeverity = mapping.severity && resolveSeverity(mapping.severity, render);
  if (resolvedSeverity) event.severity = resolvedSeverity;

  for (const key of OPTIONAL_TEXT_KEYS) {
    const tpl = mapping[key];
    if (tpl === undefined) continue;
    const text = render(tpl, key);
    if (text !== '') event[key] = text;
  }

  if (mapping.fields) {
    const fields: NonNullable<EventInputLike['fields']> = [];
    mapping.fields.forEach((field, i) => {
      const label = render(field.label, `fields.${i}.label`);
      const value = render(field.value, `fields.${i}.value`);
      if (value === '') return;
      fields.push(
        field.inline === undefined ? { label, value } : { label, value, inline: field.inline },
      );
    });
    if (fields.length > 0) event.fields = fields;
  }

  if (isPlainObject(ctx.payload)) event.data = ctx.payload;

  return errors.length > 0 ? { ok: false, errors } : { ok: true, event };
}

function resolveSeverity(
  rule: NonNullable<SourceTemplateMapping['severity']>,
  render: (tpl: string, path: string) => string,
): Severity | undefined {
  if (rule.from !== undefined) {
    const value = render(rule.from, 'severity.from');
    if (rule.map && Object.hasOwn(rule.map, value)) {
      const mapped = rule.map[value];
      if (isSeverity(mapped)) return mapped;
    }
    if (isSeverity(value)) return value;
  }
  return rule.default;
}
