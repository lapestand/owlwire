import { describe, expect, it } from 'vitest';
import { renderCoverageMarkdown } from './coverage-summary.mjs';

const m = (covered: number, total: number) => ({
  total,
  covered,
  skipped: 0,
  pct: total === 0 ? 100 : (covered / total) * 100,
});
const entry = (lines: [number, number], branches: [number, number] = [1, 1]) => ({
  lines: m(...lines),
  statements: m(...lines),
  functions: m(1, 1),
  branches: m(...branches),
});

describe('renderCoverageMarkdown', () => {
  it('prints the totals and ranks the least-covered files first', () => {
    const md = renderCoverageMarkdown(
      {
        total: entry([75, 100], [5, 10]),
        '/repo/a.ts': entry([9, 10]),
        '/repo/b.ts': entry([1, 10]),
        '/repo/c.ts': entry([10, 40]),
        '/repo/empty.ts': entry([0, 0]),
      },
      { root: '/repo', limit: 2 },
    );
    expect(md).toContain('| 75.00% | 50.00% | 100.00% | 75.00% |');
    const rows = md.split('\n').filter((l) => l.startsWith('| `'));
    expect(rows).toEqual([
      '| `b.ts` | 10.00% | 100.00% | 100.00% | 9 |',
      '| `c.ts` | 25.00% | 100.00% | 100.00% | 30 |',
    ]);
  });

  it('rejects a summary without totals', () => {
    expect(() => renderCoverageMarkdown({})).toThrow('total');
  });
});
