import { describe, expect, it } from 'vitest';
import type { Deps } from '../deps.js';
import { createLogger } from '../logger.js';
import { createTaskList } from './runner.js';

describe('createTaskList', () => {
  it('registers route_event and send_delivery', () => {
    expect(Object.keys(createTaskList({} as Deps)).sort()).toEqual([
      'route_event',
      'send_delivery',
    ]);
  });

  it('drops malformed payloads with a job-id-only warning, without touching the database or retrying', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const logger = createLogger('warn', {
      write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    // No db: any database access would throw.
    const tasks = createTaskList({ logger } as Deps);
    const helpers = (id: string) =>
      ({ job: { id } }) as Parameters<NonNullable<(typeof tasks)['route_event']>>[1];
    await expect(
      tasks.route_event?.({ wrong: 1, secretish: 'do-not-log' }, helpers('41')),
    ).resolves.toBeUndefined();
    await expect(tasks.send_delivery?.(null, helpers('42'))).resolves.toBeUndefined();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ task: 'route_event', jobId: '41' });
    expect(lines[1]).toMatchObject({ task: 'send_delivery', jobId: '42' });
    expect(JSON.stringify(lines)).not.toContain('do-not-log');
  });
});
