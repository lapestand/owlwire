import { type Block, type Inline, type Message, parseBody } from '@owlwire/core/message';
import type { RenderedMessage } from './types.js';

export const ELLIPSIS = '…';

function inlineToPlain(nodes: Inline[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') out += n.v;
    else if (n.t === 'bold' || n.t === 'italic') out += inlineToPlain(n.c);
    else {
      const label = inlineToPlain(n.c);
      out += label === n.href ? n.href : `${label} (${n.href})`;
    }
  }
  return out;
}

export function renderPlain(blocks: Block[]): string {
  return blocks
    .map((b) =>
      b.t === 'para'
        ? inlineToPlain(b.c)
        : b.items.map((item) => `- ${inlineToPlain(item)}`).join('\n'),
    )
    .join('\n\n');
}

function dropDanglingHighSurrogate(s: string): string {
  const last = s.charCodeAt(s.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? s.slice(0, -1) : s;
}

export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const cut = dropDanglingHighSurrogate(text.slice(0, Math.max(0, max - ELLIPSIS.length)));
  return { text: `${cut}${ELLIPSIS}`, truncated: true };
}

export function renderMessagePlain(msg: Message, maxLength: number): RenderedMessage {
  const main = [
    msg.title ?? '',
    renderPlain(parseBody(msg.body)),
    (msg.fields ?? []).map((f) => `${f.label}: ${f.value}`).join('\n'),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');
  const tail = msg.url ? `\n\n${msg.url}` : '';
  if (main.length + tail.length <= maxLength) return { text: `${main}${tail}`, truncated: false };
  const keptTail = tail.length <= maxLength / 2 ? tail : '';
  const cut = truncateText(main, maxLength - keptTail.length);
  return { text: `${cut.text}${keptTail}`, truncated: true };
}
