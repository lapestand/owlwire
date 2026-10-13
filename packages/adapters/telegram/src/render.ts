import { ELLIPSIS, type RenderedMessage, renderPlain } from '@owlwire/adapter-sdk';
import { type Block, type Inline, type Message, parseBody } from '@owlwire/core/message';

export const TELEGRAM_MAX_TEXT = 4096;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineToHtml(nodes: Inline[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += escapeHtml(n.v);
    else if (n.t === 'code') out += `<code>${escapeHtml(n.v)}</code>`;
    else if (n.t === 'bold') out += `<b>${inlineToHtml(n.c)}</b>`;
    else if (n.t === 'italic') out += `<i>${inlineToHtml(n.c)}</i>`;
    else out += `<a href="${escapeHtml(n.href)}">${inlineToHtml(n.c)}</a>`;
  }
  return out;
}

function blocksToHtml(blocks: Block[]): string {
  return blocks
    .map((b) =>
      b.t === 'para'
        ? inlineToHtml(b.c)
        : b.items.map((item) => `• ${inlineToHtml(item)}`).join('\n'),
    )
    .join('\n\n');
}

function safeCut(s: string, max: number): string {
  let out = s.slice(0, Math.max(0, max));
  out = out.replace(/&[a-z]*$/, '');
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

export function renderTelegramHtml(msg: Message, maxLength: number): RenderedMessage {
  const linkHtml = msg.url ? `<a href="${escapeHtml(msg.url)}">${escapeHtml(msg.url)}</a>` : '';
  const blocks = parseBody(msg.body);
  const sections = [
    msg.title ? `<b>${escapeHtml(msg.title)}</b>` : '',
    blocksToHtml(blocks),
    (msg.fields ?? [])
      .map((f) => `<b>${escapeHtml(f.label)}:</b> ${escapeHtml(f.value)}`)
      .join('\n'),
    linkHtml,
  ].filter((s) => s.length > 0);
  const full = sections.join('\n\n');
  if (full.length <= maxLength) return { text: full, parseMode: 'HTML', truncated: false };

  // Too long: fall back to escaped plain text so a cut can never break an html tag.
  const plain = [
    msg.title ?? '',
    renderPlain(blocks),
    (msg.fields ?? []).map((f) => `${f.label}: ${f.value}`).join('\n'),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');
  const tail = linkHtml && linkHtml.length <= maxLength / 2 ? `\n\n${linkHtml}` : '';
  const cut = safeCut(escapeHtml(plain), maxLength - tail.length - ELLIPSIS.length);
  return { text: `${cut}${ELLIPSIS}${tail}`, parseMode: 'HTML', truncated: true };
}
