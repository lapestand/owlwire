import { parseBody } from '@owlwire/core/message';
import { describe, expect, it } from 'vitest';
import { renderMessagePlain, renderPlain, truncateText } from './render.js';

describe('renderPlain', () => {
  it('flattens inline formatting and renders lists and links', () => {
    expect(renderPlain(parseBody('**Hi** _there_\n\n- a [docs](https://x.dev)\n- `b`'))).toBe(
      'Hi there\n\n- a docs (https://x.dev)\n- b',
    );
  });

  it('does not repeat a link whose text equals its href', () => {
    expect(renderPlain(parseBody('[https://x.dev](https://x.dev)'))).toBe('https://x.dev');
  });
});

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(truncateText('abc', 4)).toEqual({ text: 'abc', truncated: false });
  });

  it('cuts and appends an ellipsis within the limit', () => {
    expect(truncateText('abcdef', 4)).toEqual({ text: 'abc…', truncated: true });
  });

  it('never exceeds max for max 0 and 1', () => {
    expect(truncateText('abc', 0)).toEqual({ text: '', truncated: true });
    expect(truncateText('abc', 1)).toEqual({ text: '…', truncated: true });
  });

  it('never leaves half of a surrogate pair', () => {
    const r = truncateText('😀😀😀', 4);
    expect(r.text).toBe('😀…');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.text)).toBe(false);
  });
});

describe('renderMessagePlain', () => {
  it('joins title, body, fields and url', () => {
    const r = renderMessagePlain(
      {
        type: 't',
        severity: 'info',
        title: 'Gate',
        body: 'opened',
        fields: [{ label: 'Plate', value: '34 ABC 123' }],
        url: 'https://x.dev/e/1',
      },
      4000,
    );
    expect(r).toEqual({
      text: 'Gate\n\nopened\n\nPlate: 34 ABC 123\n\nhttps://x.dev/e/1',
      truncated: false,
    });
  });

  it('truncates long bodies but keeps the url at the end', () => {
    const r = renderMessagePlain(
      { type: 't', severity: 'info', body: 'x'.repeat(5000), url: 'https://x.dev/e/1' },
      100,
    );
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100);
    expect(r.text.endsWith('…\n\nhttps://x.dev/e/1')).toBe(true);
  });

  it('reports truncation when an oversized url tail is dropped', () => {
    const url = `https://x.dev/${'u'.repeat(46)}`;
    const r = renderMessagePlain({ type: 't', severity: 'info', body: 'x'.repeat(90), url }, 100);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(100);
    expect(r.text).not.toContain('https://');
  });

  it('has no leading blank lines without title or fields', () => {
    const r = renderMessagePlain(
      { type: 't', severity: 'info', body: '', url: 'https://x.dev' },
      100,
    );
    expect(r).toEqual({ text: 'https://x.dev', truncated: false });
    expect(
      renderMessagePlain({ type: 't', severity: 'info', body: 'hi', url: 'https://x.dev' }, 100)
        .text,
    ).toBe('hi\n\nhttps://x.dev');
  });

  it('stays within tiny limits', () => {
    const msg = { type: 't', severity: 'info' as const, body: 'hello', url: 'https://x.dev' };
    expect(renderMessagePlain(msg, 0)).toEqual({ text: '', truncated: true });
    const one = renderMessagePlain(msg, 1);
    expect(one.text.length).toBeLessThanOrEqual(1);
    expect(one.truncated).toBe(true);
  });
});
