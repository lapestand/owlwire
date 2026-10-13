import { describe, expect, it } from 'vitest';
import { createFakeAdapter } from './fake.js';
import type { ConnectionRef, DestinationRef } from './types.js';

const conn: ConnectionRef = {
  id: 'c',
  workspaceId: 'w',
  platform: 'webhook',
  kind: 'webhook',
  config: {},
};
const dest: DestinationRef = {
  id: 'd',
  kind: 'webhook',
  externalId: 'x',
  externalSubId: null,
  name: 'x',
};

describe('createFakeAdapter', () => {
  it('records successful sends with increasing message ids', async () => {
    const fake = createFakeAdapter();
    const rendered = fake.render(
      { type: 'generic', severity: 'info', body: '**hi**' },
      dest,
      fake.capabilities(conn),
    );
    expect(rendered.text).toBe('hi');
    expect(await fake.send(conn, dest, rendered, {})).toEqual({
      status: 'ok',
      platformMessageId: 'fake-1',
    });
    expect(await fake.send(conn, dest, rendered, {})).toEqual({
      status: 'ok',
      platformMessageId: 'fake-2',
    });
    expect(fake.sent).toHaveLength(2);
    expect(fake.platform).toBe('webhook');
  });

  it('returns queued outcomes once and does not record failed sends', async () => {
    const fake = createFakeAdapter('telegram');
    fake.nextOutcome({ status: 'transient', error: 'boom' });
    const rendered = { text: 'x', truncated: false };
    expect(await fake.send(conn, dest, rendered, {})).toEqual({
      status: 'transient',
      error: 'boom',
    });
    expect(fake.sent).toHaveLength(0);
    expect((await fake.send(conn, dest, rendered, {})).status).toBe('ok');
    expect(fake.platform).toBe('telegram');
  });
});
