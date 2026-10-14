import { describe, expect, it } from 'vitest';
import { renderMutationMarkdown } from './mutation-summary.mjs';

const mutant = (
  status: string,
  line = 1,
  replacement = 'false',
  mutatorName = 'BooleanLiteral',
) => ({
  mutatorName,
  replacement,
  status,
  location: { start: { line } },
});

describe('renderMutationMarkdown', () => {
  it('computes the score per file and overall from detected and undetected mutants', () => {
    const md = renderMutationMarkdown({
      files: {
        'b.ts': {
          mutants: [
            mutant('Killed'),
            mutant('Timeout'),
            mutant('Survived', 7),
            mutant('NoCoverage', 9),
          ],
        },
        'a.ts': { mutants: [mutant('Killed'), mutant('CompileError'), mutant('Ignored')] },
      },
    });
    expect(md).toContain('Overall mutation score: **60.00%** (3 detected, 2 undetected)');
    expect(md).toContain('| `a.ts` | 100.00% | 1 | 0 | 0 | 3 |');
    expect(md).toContain('| `b.ts` | 50.00% | 2 | 1 | 1 | 4 |');
    // Files are listed in path order.
    expect(md.indexOf('`a.ts`')).toBeLessThan(md.indexOf('`b.ts`'));
    expect(md).toContain('### Undetected mutants (2 of 2)');
    expect(md).toContain('| `b.ts:7` | Survived | BooleanLiteral | `false` |');
    expect(md).toContain('| `b.ts:9` | NoCoverage |');
  });

  it('caps the list of undetected mutants and escapes table cells', () => {
    const md = renderMutationMarkdown(
      {
        files: {
          'c.ts': {
            mutants: [
              mutant('Survived', 3, 'a | b\n`c`\\'),
              mutant('Survived', 1),
              mutant('Survived', 2),
            ],
          },
        },
      },
      { limit: 2 },
    );
    expect(md).toContain('### Undetected mutants (2 of 3)');
    expect(md).toContain('`c.ts:1`');
    expect(md).toContain('`c.ts:2`');
    expect(md).not.toContain('`c.ts:3`');
    const capped = renderMutationMarkdown({
      files: { 'c.ts': { mutants: [mutant('Survived', 3, 'a | b\n`c`\\')] } },
    });
    expect(capped).toContain("| `a \\| b 'c'\\\\` |");
  });

  it('reports n/a when a file has no scored mutants and omits the survivor table', () => {
    const md = renderMutationMarkdown({ files: { 'd.ts': { mutants: [mutant('Ignored')] } } });
    expect(md).toContain('| `d.ts` | n/a | 0 | 0 | 0 | 1 |');
    expect(md).not.toContain('Undetected mutants');
  });
});
