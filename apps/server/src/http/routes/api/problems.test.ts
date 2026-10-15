import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { NOT_FOUND_DETAIL, type ProblemError } from '../../../errors.js';
import { problem } from '../../problem.js';
import {
  CROSS_SITE_DETAIL,
  crossSiteGuard,
  httpProblem,
  MALFORMED_JSON_DETAIL,
  UNSUPPORTED_MEDIA_TYPE_DETAIL,
} from './problems.js';

describe('httpProblem', () => {
  it('keeps the client error status and uses fixed details', () => {
    expect(httpProblem(400)).toMatchObject({ status: 400, detail: MALFORMED_JSON_DETAIL });
    expect(httpProblem(415)).toMatchObject({
      status: 415,
      code: 'validation_failed',
      detail: UNSUPPORTED_MEDIA_TYPE_DETAIL,
    });
    expect(httpProblem(404)).toMatchObject({ status: 404, detail: NOT_FOUND_DETAIL });
    expect(httpProblem(413)).toMatchObject({ status: 413, code: 'payload_too_large' });
    expect(httpProblem(405)).toMatchObject({ status: 405, code: 'validation_failed' });
  });
});

describe('crossSiteGuard', () => {
  const app = new Hono();
  app.onError((err, c) => problem(c, err as ProblemError));
  app.use('*', crossSiteGuard('https://owl.example/'));
  app.all('/x', (c) => c.text('ok'));
  const send = (method: string, headers: Record<string, string>) =>
    app.request('https://owl.example/x', { method, headers });

  it('refuses unsafe methods from another origin or a cross-site fetch', async () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const refused: Array<Record<string, string>> = [
        { origin: 'https://evil.example' },
        { origin: 'https://owl.example.evil.example' },
        { origin: 'http://owl.example' },
        { 'sec-fetch-site': 'cross-site' },
      ];
      for (const headers of refused) {
        const res = await send(method, headers);
        expect(res.status, `${method} ${JSON.stringify(headers)}`).toBe(403);
        expect(await res.json()).toMatchObject({ code: 'forbidden', detail: CROSS_SITE_DETAIL });
      }
    }
  });

  it('passes the public origin, header-less clients and safe methods', async () => {
    expect((await send('POST', { origin: 'https://owl.example' })).status).toBe(200);
    expect((await send('POST', { 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    expect((await send('POST', {})).status).toBe(200);
    expect(
      (await send('GET', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }))
        .status,
    ).toBe(200);
  });
});
