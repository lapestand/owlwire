import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { INVITATION_RATE_PER_MINUTE } from '../../../system/rate-limit.js';
import { type AuthHarness, createAuthHarness } from '../../../test/auth-harness.js';

let h: AuthHarness;

beforeAll(async () => {
  h = await createAuthHarness();
}, 120_000);

afterAll(async () => {
  await h?.close();
});

const lookup = (remoteAddress: string) =>
  h.request('/api/invitations/lookup', {
    body: { token: 'ow_inv_not-a-real-invitation-token' },
    remoteAddress,
  });

describe('public invitation endpoints rate limit', () => {
  it('answers 429 with Retry-After once one address used up its budget, other addresses unaffected', async () => {
    for (let i = 0; i < INVITATION_RATE_PER_MINUTE; i++) {
      expect((await lookup('10.99.0.1')).status).not.toBe(429);
    }
    const limited = await lookup('10.99.0.1');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { code: string }).code).toBe('rate_limited');
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    expect((await lookup('10.99.0.2')).status).not.toBe(429);
  });

  it('limits accept per address as well', async () => {
    const u = await h.createUser();
    const accept = () =>
      h.request('/api/invitations/accept', {
        body: { token: 'ow_inv_not-a-real-invitation-token' },
        cookie: u.cookie,
        remoteAddress: '10.99.1.1',
      });
    for (let i = 0; i < INVITATION_RATE_PER_MINUTE; i++)
      expect((await accept()).status).not.toBe(429);
    expect((await accept()).status).toBe(429);
  });
});
