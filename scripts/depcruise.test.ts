import { describe, expect, it } from 'vitest';
import { runDepcruise } from './depcruise.mjs';

describe('runDepcruise', () => {
  it('prints why depcruise could not be started and fails', () => {
    const lines: string[] = [];
    const code = runDepcruise({
      dirs: ['apps'],
      spawn: () => ({ error: new Error('spawnSync depcruise ENOENT'), status: null, signal: null }),
      log: (line: string) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('ENOENT');
  });

  it('reports a signal and passes through the exit status', () => {
    const lines: string[] = [];
    expect(
      runDepcruise({
        dirs: [],
        spawn: () => ({ status: null, signal: 'SIGKILL' }),
        log: (l: string) => lines.push(l),
      }),
    ).toBe(1);
    expect(lines.join('\n')).toContain('SIGKILL');
    expect(
      runDepcruise({ dirs: [], spawn: () => ({ status: 0, signal: null }), log: () => undefined }),
    ).toBe(0);
    expect(
      runDepcruise({ dirs: [], spawn: () => ({ status: 3, signal: null }), log: () => undefined }),
    ).toBe(3);
  });
});
