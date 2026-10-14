import { describe, expect, it } from 'vitest';
import { renderFlakyMarkdown } from './flaky-summary.mjs';

describe('renderFlakyMarkdown', () => {
  it('reports the seed and a replay command when the run passed', () => {
    const { markdown, failures } = renderFlakyMarkdown(
      {
        success: true,
        numTotalTests: 2,
        numFailedTests: 0,
        testResults: [
          {
            name: '/repo/a.int.test.ts',
            status: 'passed',
            assertionResults: [{ fullName: 'a works', status: 'passed' }],
          },
        ],
      },
      { seed: '1234', label: 'Run 2', root: '/repo' },
    );
    expect(failures).toEqual([]);
    expect(markdown).toContain('## Run 2: passed');
    expect(markdown).toContain('Seed: `1234`');
    expect(markdown).toContain('--sequence.shuffle --sequence.seed=1234');
    expect(markdown).not.toContain('| File |');
  });

  it('lists each failed test with its file and first error line', () => {
    const { markdown, failures } = renderFlakyMarkdown(
      {
        success: false,
        numTotalTests: 3,
        numFailedTests: 1,
        testResults: [
          {
            name: '/repo/packages/db/src/x.int.test.ts',
            status: 'failed',
            assertionResults: [
              { fullName: 'x keeps order', status: 'passed' },
              {
                fullName: 'x | pipes are escaped',
                status: 'failed',
                failureMessages: ['\nAssertionError: expected 1 to be 2\n    at x.ts:1:1'],
              },
            ],
          },
        ],
      },
      { seed: '99', root: '/repo' },
    );
    expect(failures).toEqual([
      {
        file: 'packages/db/src/x.int.test.ts',
        test: 'x | pipes are escaped',
        error: 'AssertionError: expected 1 to be 2',
      },
    ]);
    expect(markdown).toContain('## Shuffled run: failed');
    expect(markdown).toContain(
      '| `packages/db/src/x.int.test.ts` | x \\| pipes are escaped | AssertionError: expected 1 to be 2 |',
    );
  });

  it('escapes backslashes before pipes in table cells', () => {
    const { markdown } = renderFlakyMarkdown(
      {
        success: false,
        testResults: [
          {
            name: '/repo/c.int.test.ts',
            status: 'failed',
            assertionResults: [
              { fullName: 'a \\| b', status: 'failed', failureMessages: ['Error: x'] },
            ],
          },
        ],
      },
      { seed: '3', root: '/repo' },
    );
    expect(markdown).toContain('| a \\\\\\| b |');
  });

  it('reports a file that failed outside of a test, such as a failing hook', () => {
    const { failures } = renderFlakyMarkdown(
      {
        success: false,
        testResults: [
          {
            name: '/repo/b.int.test.ts',
            status: 'failed',
            message: 'Error: hook timed out',
            assertionResults: [],
          },
        ],
      },
      { seed: '7', root: '/repo' },
    );
    expect(failures).toEqual([
      { file: 'b.int.test.ts', test: '(file or hook)', error: 'Error: hook timed out' },
    ]);
  });

  it('marks the run failed even when the report names no failing test', () => {
    const { markdown } = renderFlakyMarkdown({ success: false, testResults: [] }, { seed: '1' });
    expect(markdown).toContain(': failed');
    expect(markdown).toContain('see the job log');
  });
});
