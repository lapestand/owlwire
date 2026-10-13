import type { Message } from '@owlwire/core/message';
import { describe, expect, it } from 'vitest';
import type { ChannelAdapter, ConnectionRef, DestinationRef, SendOutcome } from './types.js';

type Arrange = () => void | Promise<void>;

export interface ConformanceFixtures {
  connection: ConnectionRef;
  destination: DestinationRef;
  message: Message;
  /** Prepares the adapter's fake platform for the next send. */
  arrange: {
    ok: Arrange;
    transient: Arrange;
    rateLimited: (retryAfterMs: number) => void | Promise<void>;
    permanent: Arrange;
    /** Platforms without a ban signal leave this out; the scenario is skipped. */
    banned?: Arrange;
  };
}

/** Shared adapter contract tests; call it at the top level of an adapter's *.test.ts file. */
export function runConformanceSuite(
  name: string,
  make: () => ChannelAdapter,
  fixtures: ConformanceFixtures,
): void {
  const { connection, destination, message, arrange } = fixtures;

  async function sendOnce(): Promise<SendOutcome> {
    const adapter = make();
    const rendered = adapter.render(message, destination, adapter.capabilities(connection));
    return adapter.send(connection, destination, rendered, {});
  }

  describe(`adapter conformance: ${name}`, () => {
    it('declares capabilities and renders within the body limit', () => {
      const adapter = make();
      const caps = adapter.capabilities(connection);
      expect(caps.maxBodyLength).toBeGreaterThan(0);
      const rendered = adapter.render(message, destination, caps);
      expect(rendered.text.length).toBeLessThanOrEqual(caps.maxBodyLength);
      expect(typeof rendered.truncated).toBe('boolean');
      expect(typeof adapter.platformLimits(connection)).toBe('object');
    });

    it('returns ok for a successful send', async () => {
      await arrange.ok();
      expect((await sendOnce()).status).toBe('ok');
    });

    it('maps a temporary platform failure to transient', async () => {
      await arrange.transient();
      expect((await sendOnce()).status).toBe('transient');
    });

    it('maps a platform rate limit to rate_limited with a retry delay', async () => {
      await arrange.rateLimited(2000);
      const out = await sendOnce();
      expect(out.status).toBe('rate_limited');
      if (out.status === 'rate_limited') expect(out.retryAfterMs).toBeGreaterThan(0);
    });

    it('maps a rejected destination to permanent', async () => {
      await arrange.permanent();
      expect((await sendOnce()).status).toBe('permanent');
    });

    it.skipIf(!arrange.banned)('maps a revoked or banned account to banned', async () => {
      await arrange.banned?.();
      expect((await sendOnce()).status).toBe('banned');
    });
  });
}
