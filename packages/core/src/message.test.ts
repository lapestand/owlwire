import { describe, expect, it } from 'vitest';
import { isSeverity, parseBody, SEVERITIES, severityRank } from './message.js';

describe('severity', () => {
  it('ranks severities from info to critical', () => {
    expect(SEVERITIES.map(severityRank)).toEqual([0, 1, 2, 3, 4]);
    expect(severityRank('high')).toBeGreaterThan(severityRank('medium'));
  });

  it('recognises valid severities only', () => {
    expect(isSeverity('critical')).toBe(true);
    expect(isSeverity('urgent')).toBe(false);
    expect(isSeverity(3)).toBe(false);
  });
});

describe('parseBody', () => {
  it('returns no blocks for an empty body', () => {
    expect(parseBody('')).toEqual([]);
    expect(parseBody('\n\n')).toEqual([]);
  });

  it('parses a plain paragraph and keeps single newlines inside it', () => {
    expect(parseBody('line one\nline two')).toEqual([
      { t: 'para', c: [{ t: 'text', v: 'line one\nline two' }] },
    ]);
  });

  it('splits paragraphs on blank lines and normalises CRLF', () => {
    expect(parseBody('first\r\n\r\nsecond')).toEqual([
      { t: 'para', c: [{ t: 'text', v: 'first' }] },
      { t: 'para', c: [{ t: 'text', v: 'second' }] },
    ]);
  });

  it('parses bold, italic, code and links', () => {
    expect(parseBody('**Alarm** at _gate_ `G-1` see [map](https://example.com/m)')).toEqual([
      {
        t: 'para',
        c: [
          { t: 'bold', c: [{ t: 'text', v: 'Alarm' }] },
          { t: 'text', v: ' at ' },
          { t: 'italic', c: [{ t: 'text', v: 'gate' }] },
          { t: 'text', v: ' ' },
          { t: 'code', v: 'G-1' },
          { t: 'text', v: ' see ' },
          { t: 'link', href: 'https://example.com/m', c: [{ t: 'text', v: 'map' }] },
        ],
      },
    ]);
  });

  it('supports nesting inside bold', () => {
    expect(parseBody('**very _bad_ news**')).toEqual([
      {
        t: 'para',
        c: [
          {
            t: 'bold',
            c: [
              { t: 'text', v: 'very ' },
              { t: 'italic', c: [{ t: 'text', v: 'bad' }] },
              { t: 'text', v: ' news' },
            ],
          },
        ],
      },
    ]);
  });

  it('does not treat snake_case identifiers as italic', () => {
    expect(parseBody('user_name_here is idle')).toEqual([
      { t: 'para', c: [{ t: 'text', v: 'user_name_here is idle' }] },
    ]);
  });

  it('keeps unclosed markers and non-http links as text', () => {
    expect(parseBody('**open and [x](javascript:alert(1))')).toEqual([
      { t: 'para', c: [{ t: 'text', v: '**open and [x](javascript:alert(1))' }] },
    ]);
  });

  it('parses lists that start with "- " and separates them from paragraphs', () => {
    expect(parseBody('Inactive:\n- **alpha**\n- beta\nafter')).toEqual([
      { t: 'para', c: [{ t: 'text', v: 'Inactive:' }] },
      {
        t: 'list',
        items: [[{ t: 'bold', c: [{ t: 'text', v: 'alpha' }] }], [{ t: 'text', v: 'beta' }]],
      },
      { t: 'para', c: [{ t: 'text', v: 'after' }] },
    ]);
  });
});
