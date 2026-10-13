import { describe, expect, it } from 'vitest';
import { DevApiError, fetchDeliveries } from './api';

function stubFetch(
  status: number,
  body: unknown,
  seen: Array<{ url: string; auth: string | null }>,
) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('fetchDeliveries', () => {
  it('sends the dev token and returns the list', async () => {
    const seen: Array<{ url: string; auth: string | null }> = [];
    const list = { deliveries: [] };
    expect(await fetchDeliveries('tok', stubFetch(200, list, seen), 'http://x')).toEqual(list);
    expect(seen).toEqual([{ url: 'http://x/api/dev/deliveries?limit=100', auth: 'Bearer tok' }]);
  });

  it('turns problem details into a DevApiError', async () => {
    const problem = {
      status: 401,
      code: 'unauthorized',
      title: 'Unauthorized',
      detail: 'invalid dev admin token',
    };
    const err = await fetchDeliveries('bad', stubFetch(401, problem, [])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DevApiError);
    expect((err as DevApiError).status).toBe(401);
    expect((err as DevApiError).message).toBe('invalid dev admin token');
  });

  it('copes with a non-JSON error body', async () => {
    const fetchImpl = (async () => new Response('gateway down', { status: 502 })) as typeof fetch;
    const err = await fetchDeliveries('t', fetchImpl).catch((e: unknown) => e);
    expect((err as DevApiError).status).toBe(502);
  });
});
