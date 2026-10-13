import { describe, expect, it } from 'vitest';
import type { Deps } from '../deps.js';
import { createLogger } from '../logger.js';
import { createTaskList, graphileLogger, sanitizeTaskList } from './runner.js';

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

describe('graphileLogger', () => {
  it('routes graphile errors through the err serializer and scrubs query params (I-6)', () => {
    const lines: string[] = [];
    const log = graphileLogger(createLogger('debug', { write: (l: string) => void lines.push(l) }));
    const error = Object.assign(new Error('Failed query: select $1\nparams: SECRET-PARAM'), {
      params: ['SECRET-PARAM'],
    });
    log.error(
      "Failed task 7 (send_delivery, 1.00ms, attempt 1 of 25) with error 'Failed query: select $1\nparams: SECRET-PARAM':\n  Error: Failed query: select $1\n  params: SECRET-PARAM\n      at x (y.js:1:1)",
      {
        failure: true,
        job: {
          id: '7',
          task_identifier: 'send_delivery',
          attempts: 1,
          max_attempts: 25,
          last_error: 'params: SECRET-PARAM',
          payload: { deliveryId: 'd1' },
        },
        error,
        duration: 1,
      },
    );
    expect(lines.join('\n')).not.toContain('SECRET-PARAM');
    const out = JSON.parse(lines[0] ?? '{}');
    expect(out.level).toBe(50);
    expect(out.msg).toContain('Failed task 7');
    expect(out.err.message).toBe('Failed query: select $1\nparams: [redacted]');
    expect(out.error).toBeUndefined();
    expect(out.job).toEqual({
      id: '7',
      task_identifier: 'send_delivery',
      attempts: 1,
      max_attempts: 25,
    });
  });
});

describe('sanitizeTaskList', () => {
  it('rethrows any task error as its safe message without a cause', async () => {
    const query = Object.assign(new Error('Failed query: select $1\nparams: SECRET-TASK'), {
      params: ['SECRET-TASK'],
    });
    const tasks = sanitizeTaskList({
      raw: async () => {
        throw query;
      },
    });
    const err = await Promise.resolve(
      tasks.raw?.({}, {} as Parameters<NonNullable<(typeof tasks)['raw']>>[1]),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('Error: Failed query: select $1');
    expect((err as Error).cause).toBeUndefined();
  });
});
