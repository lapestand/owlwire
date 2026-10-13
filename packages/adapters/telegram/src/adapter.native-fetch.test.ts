import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AdapterDeps, ConnectionRef, DestinationRef } from '@owlwire/adapter-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { createTelegramAdapter } from './adapter.js';

// Regression: grammY passes its own (polyfilled) AbortSignal as init.signal. Node's
// native fetch rejects anything that is not a native AbortSignal, so every request
// failed before reaching the network. These tests use the REAL globalThis.fetch
// against a local fake Bot API to catch that class of bug.

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

interface FakeBotApi {
  apiRoot: string;
  calls: Array<{ path: string; body: string }>;
  closed: Promise<void>;
}

let server: Server | undefined;

async function startFakeBotApi(handler: Handler): Promise<FakeBotApi> {
  const calls: FakeBotApi['calls'] = [];
  let markClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    req.on('end', () => {
      calls.push({ path: req.url ?? '', body });
      handler(req, body, res);
    });
    res.on('close', () => markClosed());
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { apiRoot: `http://127.0.0.1:${port}`, calls, closed };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

const json = (res: ServerResponse, status: number, payload: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const noop = () => {};
const deps: AdapterDeps = {
  logger: { info: noop, warn: noop, error: noop, debug: noop },
  fetch: globalThis.fetch,
  clock: { now: () => new Date('2026-10-12T10:00:00.000Z') },
};

const conn: ConnectionRef = {
  id: 'c1',
  workspaceId: 'w1',
  platform: 'telegram',
  kind: 'own_bot',
  config: { botToken: '123:ABC' },
};
const group: DestinationRef = {
  id: 'd1',
  kind: 'group',
  externalId: '-1001234',
  externalSubId: null,
  name: 'g',
};
const rendered = { text: '<b>hi</b>', parseMode: 'HTML' as const, truncated: false };

describe('telegram adapter with the native fetch', () => {
  it('sends a message through the real fetch implementation', async () => {
    const api = await startFakeBotApi((_req, _body, res) =>
      json(res, 200, { ok: true, result: { message_id: 99 } }),
    );
    const adapter = createTelegramAdapter(deps, { apiRoot: api.apiRoot });
    const outcome = await adapter.send(conn, group, rendered, {});
    expect(outcome).toEqual({ status: 'ok', platformMessageId: '99' });
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.path).toBe('/bot123:ABC/sendMessage');
    expect(JSON.parse(api.calls[0]?.body ?? '{}')).toMatchObject({
      chat_id: '-1001234',
      text: '<b>hi</b>',
      parse_mode: 'HTML',
    });
  });

  it('checks health with getMe through the real fetch implementation', async () => {
    const api = await startFakeBotApi((_req, _body, res) =>
      json(res, 200, {
        ok: true,
        result: { id: 1, is_bot: true, first_name: 'b', username: 'b_bot' },
      }),
    );
    const adapter = createTelegramAdapter(deps, { apiRoot: api.apiRoot });
    expect(await adapter.health(conn)).toEqual({ status: 'active' });
    expect(api.calls[0]?.path).toBe('/bot123:ABC/getMe');
  });

  it('times out a hanging request as transient and aborts the connection', async () => {
    // The server accepts the request and never answers.
    const api = await startFakeBotApi(() => {});
    const adapter = createTelegramAdapter(deps, { apiRoot: api.apiRoot, timeoutSeconds: 1 });
    const started = Date.now();
    const outcome = await adapter.send(conn, group, rendered, {});
    expect(outcome.status).toBe('transient');
    expect(Date.now() - started).toBeLessThan(5000);
    // The request must have reached the server, and the timeout must abort the socket.
    expect(api.calls).toHaveLength(1);
    await api.closed;
  });
});
