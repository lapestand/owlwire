import { describe, expect, it } from 'vitest';
import {
  MAX_TEMPLATE_LENGTH,
  parseTemplate,
  renderTemplateString,
  TemplateError,
} from './template.js';

function errorOf(tpl: string): TemplateError {
  const parsed = parseTemplate(tpl);
  if (parsed.ok) throw new Error(`expected ${JSON.stringify(tpl)} to be rejected`);
  expect(parsed.error).toBeInstanceOf(TemplateError);
  expect(() => renderTemplateString(tpl, {})).toThrow(TemplateError);
  return parsed.error;
}

describe('renderTemplateString', () => {
  it('returns plain text unchanged', () => {
    expect(renderTemplateString('just text, no braces }}', {})).toBe('just text, no braces }}');
    expect(renderTemplateString('', {})).toBe('');
  });

  it('substitutes one and several variables', () => {
    expect(renderTemplateString('hi {{name}}', { name: 'Ada' })).toBe('hi Ada');
    expect(renderTemplateString('{{a}}-{{b}}/{{a}}', { a: 'x', b: 'y' })).toBe('x-y/x');
  });

  it('walks dotted paths and array indexes', () => {
    const data = {
      payload: {
        alerts: [{ labels: { alertname: 'DiskFull' } }, { labels: { alertname: 'CPU' } }],
      },
    };
    expect(renderTemplateString('{{ payload.alerts[0].labels.alertname }}', data)).toBe('DiskFull');
    expect(renderTemplateString('{{ payload.alerts[1].labels.alertname }}', data)).toBe('CPU');
    expect(renderTemplateString('{{ payload.alerts[2].labels.alertname }}', data)).toBe('');
    expect(renderTemplateString('{{ m[0][1] }}', { m: [['a', 'b']] })).toBe('b');
  });

  it('only indexes arrays with numeric segments', () => {
    expect(renderTemplateString('{{ list.length }}', { list: [1, 2, 3] })).toBe('');
    expect(renderTemplateString('{{ obj[0] }}', { obj: { 0: 'zero' } })).toBe('zero');
  });

  it('reads bracketed string keys', () => {
    const data = {
      payload: { 'a.b': 'dotted key', a: { b: 'nested' }, labels: { 'team name': 'core' } },
    };
    expect(renderTemplateString('{{ payload["a.b"] }}', data)).toBe('dotted key');
    expect(renderTemplateString('{{ payload.a.b }}', data)).toBe('nested');
    expect(renderTemplateString('{{ payload.labels["team name"] }}', data)).toBe('core');
    expect(renderTemplateString('{{ p["say \\"hi\\""] }}', { p: { 'say "hi"': 'quoted' } })).toBe(
      'quoted',
    );
    expect(renderTemplateString('{{ p["back\\\\slash"] }}', { p: { 'back\\slash': 'bs' } })).toBe(
      'bs',
    );
    expect(renderTemplateString('{{ p["}}"] }}', { p: { '}}': 'braces' } })).toBe('braces');
    expect(renderTemplateString('{{ p["x"]["y"].z }}', { p: { x: { y: { z: 'deep' } } } })).toBe(
      'deep',
    );
  });

  it('rejects malformed bracket keys with a position', () => {
    expect(errorOf('ab {{ payload["a.b }}').position).toBe(14);
    expect(errorOf('{{ payload["a.b" }}').position).toBe(16);
    expect(errorOf('{{ payload[0 }}').position).toBe(12);
    expect(errorOf('{{ payload["\\n"] }}').position).toBe(12);
    expect(errorOf('{{ payload[] }}').position).toBe(11);
    expect(errorOf('{{ payload[-1] }}').position).toBe(11);
  });

  it('never reaches the prototype chain through a bracket key', () => {
    expect(renderTemplateString('{{ p["__proto__"] }}', { p: {} })).toBe('');
    expect(renderTemplateString('{{ p["constructor"] }}', { p: {} })).toBe('');
    expect(
      renderTemplateString('{{ p["__proto__"] }}', { p: JSON.parse('{"__proto__":"own"}') }),
    ).toBe('');
  });

  it('accepts dashes in plain segments', () => {
    expect(
      renderTemplateString('{{ headers.x-github-event }}', {
        headers: { 'x-github-event': 'push' },
      }),
    ).toBe('push');
  });

  it('renders missing paths and null as empty text', () => {
    expect(renderTemplateString('[{{ nope }}]', {})).toBe('[]');
    expect(renderTemplateString('[{{ a.b.c }}]', { a: 'str' })).toBe('[]');
    expect(renderTemplateString('[{{ a }}]', { a: null })).toBe('[]');
    expect(renderTemplateString('[{{ a }}]', null)).toBe('[]');
    expect(renderTemplateString('[{{ a }}]', 'text')).toBe('[]');
  });

  it('writes strings as they are and numbers and booleans with String()', () => {
    expect(renderTemplateString('{{ s }}', { s: '<b>{{x}}</b>' })).toBe('<b>{{x}}</b>');
    expect(
      renderTemplateString('{{ n }} {{ f }} {{ t }} {{ z }}', { n: 42.5, f: false, t: true, z: 0 }),
    ).toBe('42.5 false true 0');
  });

  it('writes objects and arrays as JSON text', () => {
    expect(renderTemplateString('{{ o }}', { o: { a: 1, b: [true, null] } })).toBe(
      '{"a":1,"b":[true,null]}',
    );
    expect(renderTemplateString('{{ l }}', { l: ['x', 2] })).toBe('["x",2]');
  });

  it('writes values JSON cannot encode as empty text instead of throwing', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(renderTemplateString('[{{ c }}]', { c: cyclic })).toBe('[]');
    expect(renderTemplateString('[{{ b }}]', { b: { n: 1n } })).toBe('[]');
    expect(renderTemplateString('[{{ f }}]', { f: () => 'run' })).toBe('[]');
  });

  it('trims whitespace inside the braces', () => {
    expect(renderTemplateString('{{a}}|{{  a  }}|{{\ta\n}}', { a: 'v' })).toBe('v|v|v');
  });

  it('rejects an unclosed {{ with its position', () => {
    const err = errorOf('hello {{ name');
    expect(err.position).toBe(6);
    expect(err.message).toMatch(/unclosed/);
    expect(errorOf('a }} b {{').position).toBe(7);
  });

  it('never evaluates expressions', () => {
    for (const tpl of [
      '{{ a + b }}',
      '{{#if x}}y{{/if}}',
      '{{ a | upper }}',
      '{{ a() }}',
      '{{ }}',
      '{{ .a }}',
      '{{ a. }}',
      '{{ a..b }}',
      '{{ ["a"] }}',
      '{{ [0] }}',
      '{{ a b }}',
      '{{{ a }}}',
      '{{ `x` }}',
      '{{ a.b c }}',
    ]) {
      errorOf(tpl);
    }
    expect(errorOf('ab{{ a + b }}').position).toBe(7);
  });

  it('renders __proto__, constructor and prototype segments as empty text', () => {
    const data = { a: { b: 1 }, fn: { prototype: 'p' } };
    expect(renderTemplateString('[{{ a.__proto__ }}]', data)).toBe('[]');
    expect(renderTemplateString('[{{ a.constructor }}]', data)).toBe('[]');
    expect(renderTemplateString('[{{ a.constructor.name }}]', data)).toBe('[]');
    expect(renderTemplateString('[{{ fn.prototype }}]', data)).toBe('[]');
    expect(renderTemplateString('[{{ __proto__ }}]', data)).toBe('[]');
    expect(renderTemplateString('[{{ a.toString }}]', data)).toBe('[]');
    expect(renderTemplateString('[{{ a.hasOwnProperty }}]', data)).toBe('[]');
  });

  it('rejects a template longer than the limit', () => {
    expect(MAX_TEMPLATE_LENGTH).toBe(8000);
    expect(parseTemplate('x'.repeat(MAX_TEMPLATE_LENGTH)).ok).toBe(true);
    const err = errorOf('x'.repeat(MAX_TEMPLATE_LENGTH + 1));
    expect(err.position).toBe(MAX_TEMPLATE_LENGTH);
  });
});
