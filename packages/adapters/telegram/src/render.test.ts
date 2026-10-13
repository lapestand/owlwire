import { describe, expect, it } from 'vitest';
import { escapeHtml, renderTelegramHtml, TELEGRAM_MAX_TEXT } from './render.js';

const base = { type: 'generic', severity: 'info' as const };

describe('renderTelegramHtml', () => {
  it('converts owlwire markdown to telegram html', () => {
    const r = renderTelegramHtml(
      {
        ...base,
        title: 'Attack',
        body: '**Polis** under _siege_ `x<y`\n\n- [map](https://x.dev/m?a=1&b=2)',
        fields: [{ label: 'Units', value: '12 & more' }],
        url: 'https://x.dev/e/1',
      },
      TELEGRAM_MAX_TEXT,
    );
    expect(r).toEqual({
      text:
        '<b>Attack</b>\n\n' +
        '<b>Polis</b> under <i>siege</i> <code>x&lt;y</code>\n\n' +
        '• <a href="https://x.dev/m?a=1&amp;b=2">map</a>\n\n' +
        '<b>Units:</b> 12 &amp; more\n\n' +
        '<a href="https://x.dev/e/1">https://x.dev/e/1</a>',
      parseMode: 'HTML',
      truncated: false,
    });
  });

  it('escapes html special characters', () => {
    const r = renderTelegramHtml({ ...base, body: '<script>alert("x")</script> a < b & c' }, 4096);
    expect(r.text).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; a &lt; b &amp; c');
    expect(escapeHtml('"<&>"')).toBe('&quot;&lt;&amp;&gt;&quot;');
  });

  it('truncates long messages to the limit and marks them', () => {
    const r = renderTelegramHtml(
      { ...base, body: 'a'.repeat(5000), url: 'https://x.dev/e/1' },
      4096,
    );
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(4096);
    expect(r.text.endsWith('…\n\n<a href="https://x.dev/e/1">https://x.dev/e/1</a>')).toBe(true);
  });

  it('never cuts inside an html entity', () => {
    const r = renderTelegramHtml({ ...base, body: '&'.repeat(3000) }, 4096);
    expect(r.text.length).toBeLessThanOrEqual(4096);
    expect(/&(?!amp;|lt;|gt;|quot;)/.test(r.text)).toBe(false);
  });

  it('never leaves a lone surrogate when cutting emoji', () => {
    const r = renderTelegramHtml({ ...base, body: '😀'.repeat(3000) }, 4096);
    expect(r.text.length).toBeLessThanOrEqual(4096);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(r.text)).toBe(false);
  });
});
