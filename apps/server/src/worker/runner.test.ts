import { describe, expect, it } from 'vitest';
import type { Deps } from '../deps.js';
import { createTaskList } from './runner.js';

describe('createTaskList', () => {
  it('registers route_event and send_delivery', () => {
    expect(Object.keys(createTaskList({} as Deps)).sort()).toEqual([
      'route_event',
      'send_delivery',
    ]);
  });

  it('rejects malformed payloads before touching the database', async () => {
    const tasks = createTaskList({} as Deps);
    const helpers = {} as Parameters<NonNullable<(typeof tasks)['route_event']>>[1];
    await expect(tasks.route_event?.({ wrong: 1 }, helpers)).rejects.toThrow();
    await expect(tasks.send_delivery?.(null, helpers)).rejects.toThrow();
  });
});
