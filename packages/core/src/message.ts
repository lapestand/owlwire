export const SEVERITIES = ['info', 'low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(s: Severity): number {
  return SEVERITIES.indexOf(s);
}

export function isSeverity(v: unknown): v is Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v);
}

export interface MessageField {
  label: string;
  value: string;
  inline?: boolean;
}

export interface Message {
  type: string;
  severity: Severity;
  title?: string;
  body: string;
  fields?: MessageField[];
  url?: string;
  imageUrl?: string;
  groupKey?: string;
  summary?: string;
  locale?: string;
  data?: Record<string, unknown>;
}

// Owlwire markdown: **bold**, _italic_, `code`, [text](https://url), "- " list lines, blank line = paragraph.
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'bold'; c: Inline[] }
  | { t: 'italic'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };
export type Block = { t: 'para'; c: Inline[] } | { t: 'list'; items: Inline[][] };

const LINK_RE = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/y;
const WORD_CHAR = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function isOpeningUnderscore(s: string, i: number): boolean {
  const prev = s.charAt(i - 1);
  const next = s.charAt(i + 1);
  return (prev === '' || !WORD_CHAR.test(prev)) && next !== '' && !SPACE.test(next) && next !== '_';
}

function findClosingUnderscore(s: string, from: number): number {
  for (let j = from + 1; j < s.length; j++) {
    if (s.charAt(j) !== '_') continue;
    const prev = s.charAt(j - 1);
    const next = s.charAt(j + 1);
    if (!SPACE.test(prev) && (next === '' || !WORD_CHAR.test(next))) return j;
  }
  return -1;
}

function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const pushText = () => {
    if (text.length > 0) {
      out.push({ t: 'text', v: text });
      text = '';
    }
  };
  let i = 0;
  while (i < src.length) {
    const ch = src.charAt(i);
    if (ch === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i + 1) {
        pushText();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === '*' && src.charAt(i + 1) === '*') {
      const end = src.indexOf('**', i + 2);
      if (end > i + 2) {
        pushText();
        out.push({ t: 'bold', c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    } else if (ch === '_' && isOpeningUnderscore(src, i)) {
      const end = findClosingUnderscore(src, i);
      if (end !== -1) {
        pushText();
        out.push({ t: 'italic', c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    } else if (ch === '[') {
      LINK_RE.lastIndex = i;
      const m = LINK_RE.exec(src);
      if (m) {
        const next = i + m[0].length;
        pushText();
        out.push({ t: 'link', href: m[2] ?? '', c: parseInline(m[1] ?? '') });
        i = next;
        continue;
      }
    }
    text += ch;
    i += 1;
  }
  pushText();
  return out;
}

export function parseBody(body: string): Block[] {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  let items: string[] = [];
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ t: 'para', c: parseInline(para.join('\n')) });
      para = [];
    }
  };
  const flushList = () => {
    if (items.length > 0) {
      blocks.push({ t: 'list', items: items.map(parseInline) });
      items = [];
    }
  };
  for (const line of lines) {
    if (line.trim() === '') {
      flushPara();
      flushList();
    } else if (line.startsWith('- ')) {
      flushPara();
      items.push(line.slice(2));
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return blocks;
}
