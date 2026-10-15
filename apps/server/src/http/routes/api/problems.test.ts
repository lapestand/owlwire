import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { NOT_FOUND_DETAIL, type ProblemError } from '../../../errors.js';
import { problem } from '../../problem.js';
import {
  CROSS_SITE_DETAIL,
  crossSiteGuard,
  DEFAULT_RETRY_AFTER_SECONDS,
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

describe('httpProblem for 429', () => {
  it('answers rate_limited with the upstream Retry-After', () => {
    expect(httpProblem(429, '7')).toMatchObject({
      status: 429,
      code: 'rate_limited',
      headers: { 'Retry-After': '7' },
    });
    const date = 'Wed, 21 Oct 2026 07:28:00 GMT';
    expect(httpProblem(429, date).headers).toEqual({ 'Retry-After': date });
  });

  it('falls back to a default Retry-After when the upstream value is missing or unusable', () => {
    const fallback = { 'Retry-After': String(DEFAULT_RETRY_AFTER_SECONDS) };
    expect(httpProblem(429).headers).toEqual(fallback);
    expect(httpProblem(429, '').headers).toEqual(fallback);
    expect(httpProblem(429, 'soon').headers).toEqual(fallback);
    expect(httpProblem(429, '-3').headers).toEqual(fallback);
  });

  it('sends the header on the response', async () => {
    const app = new Hono();
    app.onError((err, c) => problem(c, err as ProblemError));
    app.get('/x', () => {
      throw httpProblem(429);
    });
    const res = await app.request('https://owl.example/x');
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe(String(DEFAULT_RETRY_AFTER_SECONDS));
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
