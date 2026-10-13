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
});
