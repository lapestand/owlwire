import type { AdapterDeps, ConnectionRef, DestinationRef } from '@owlwire/adapter-sdk';
import { describe, expect, it } from 'vitest';
import { createTelegramAdapter } from './adapter.js';

type Reply = { status: number; json: unknown } | Error;

function fakeFetch(reply: (method: string, body: Record<string, unknown>) => Reply) {
  const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = url.slice(url.lastIndexOf('/') + 1);
    const raw = typeof init?.body === 'string' ? init.body : '{}';
    const body = JSON.parse(raw) as Record<string, unknown>;
    calls.push({ url, method, body });
    const r = reply(method, body);
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.json), {
      status: r.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { fn, calls };
}

const noop = () => {};
function deps(fetchFn: typeof fetch): AdapterDeps {
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    fetch: fetchFn,
    clock: { now: () => new Date('2026-10-12T10:00:00.000Z') },
  };
}

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

describe('telegram adapter send', () => {
  it('sends html via sendMessage with the connection bot token', async () => {
    const f = fakeFetch(() => ({ status: 200, json: { ok: true, result: { message_id: 42 } } }));
    const adapter = createTelegramAdapter(deps(f.fn), {});
    const outcome = await adapter.send(conn, group, rendered, {});
    expect(outcome).toEqual({ status: 'ok', platformMessageId: '42' });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]?.url).toContain('/bot123:ABC/sendMessage');
    expect(f.calls[0]?.body).toMatchObject({
      chat_id: '-1001234',
      text: '<b>hi</b>',
      parse_mode: 'HTML',
    });
    expect(f.calls[0]?.body.message_thread_id).toBeUndefined();
  });

  it('passes the topic id as message_thread_id', async () => {
    const f = fakeFetch(() => ({ status: 200, json: { ok: true, result: { message_id: 1 } } }));
    const adapter = createTelegramAdapter(deps(f.fn), {});
    await adapter.send(conn, { ...group, kind: 'topic', externalSubId: '77' }, rendered, {});
    expect(f.calls[0]?.body.message_thread_id).toBe(77);
  });

  it('maps 429 to rate_limited with retry_after', async () => {
    const f = fakeFetch(() => ({
      status: 429,
      json: {
        ok: false,
        error_code: 429,
        description: 'Too Many Requests: retry after 5',
        parameters: { retry_after: 5 },
      },
    }));
    const outcome = await createTelegramAdapter(deps(f.fn), {}).send(conn, group, rendered, {});
    expect(outcome).toEqual({ status: 'rate_limited', retryAfterMs: 5000 });
  });

  it('maps a kicked bot to a permanent error that breaks the destination', async () => {
    const f = fakeFetch(() => ({
      status: 403,
      json: {
        ok: false,
        error_code: 403,
        description: 'Forbidden: bot was kicked from the group chat',
      },
    }));
    const outcome = await createTelegramAdapter(deps(f.fn), {}).send(conn, group, rendered, {});
    expect(outcome).toMatchObject({ status: 'permanent', destinationBroken: true });
  });

  it('maps an invalid token to a permanent error that keeps the destination', async () => {
    const f = fakeFetch(() => ({
      status: 401,
      json: { ok: false, error_code: 401, description: 'Unauthorized' },
    }));
    const outcome = await createTelegramAdapter(deps(f.fn), {}).send(conn, group, rendered, {});
    expect(outcome).toMatchObject({ status: 'permanent', destinationBroken: false });
  });

  it('maps server errors and network failures to transient', async () => {
    const f5 = fakeFetch(() => ({
      status: 502,
      json: { ok: false, error_code: 502, description: 'Bad Gateway' },
    }));
    expect(
      (await createTelegramAdapter(deps(f5.fn), {}).send(conn, group, rendered, {})).status,
    ).toBe('transient');
    const fnet = fakeFetch(() => new Error('ECONNRESET'));
    expect(
      (await createTelegramAdapter(deps(fnet.fn), {}).send(conn, group, rendered, {})).status,
    ).toBe('transient');
  });

  it('refuses connections without a bot token and shared bots in P0', async () => {
    const f = fakeFetch(() => ({ status: 200, json: { ok: true, result: { message_id: 1 } } }));
    const adapter = createTelegramAdapter(deps(f.fn), { botToken: 'shared' });
    expect(await adapter.send({ ...conn, config: {} }, group, rendered, {})).toMatchObject({
      status: 'permanent',
    });
    expect(
      await adapter.send({ ...conn, kind: 'shared_bot', config: {} }, group, rendered, {}),
    ).toMatchObject({ status: 'permanent' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('telegram adapter health', () => {
  it('reports active when getMe succeeds and broken on 401', async () => {
    const ok = fakeFetch(() => ({
      status: 200,
      json: { ok: true, result: { id: 1, is_bot: true, first_name: 'b', username: 'b_bot' } },
    }));
    expect(await createTelegramAdapter(deps(ok.fn), {}).validateConnection(conn)).toEqual({
      status: 'active',
    });
    const bad = fakeFetch(() => ({
      status: 401,
      json: { ok: false, error_code: 401, description: 'Unauthorized' },
    }));
    expect(await createTelegramAdapter(deps(bad.fn), {}).health(conn)).toEqual({
      status: 'broken',
      reason: 'telegram.status.invalidBotToken',
    });
  });

  it('uses machine status keys and keeps raw errors out of the health reason', async () => {
    const down = fakeFetch(() => new Error('connect ECONNREFUSED 10.0.0.1:443'));
    const warnings: unknown[] = [];
    const d = deps(down.fn);
    d.logger.warn = (obj) => {
      warnings.push(obj);
    };
    const adapter = createTelegramAdapter(d, {});
    expect(await adapter.health(conn)).toEqual({
      status: 'degraded',
      reason: 'telegram.status.unreachable',
    });
    expect(warnings).toHaveLength(1);
    expect(await adapter.validateConnection({ ...conn, config: {} })).toEqual({
      status: 'broken',
      reason: 'telegram.status.missingBotToken',
    });
  });

  it('declares html formatting and the 4096 character limit', () => {
    const caps = createTelegramAdapter(deps(fakeFetch(() => new Error('x')).fn), {}).capabilities(
      conn,
    );
    expect(caps).toMatchObject({ formatting: 'telegram_html', maxBodyLength: 4096 });
  });
});
