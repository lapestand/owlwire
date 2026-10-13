import { runConformanceSuite } from './conformance.js';
import { createFakeAdapter } from './fake.js';

const fake = createFakeAdapter('webhook');

runConformanceSuite('fake', () => fake, {
  connection: { id: 'c', workspaceId: 'w', platform: 'webhook', kind: 'webhook', config: {} },
  destination: { id: 'd', kind: 'webhook', externalId: 'x', externalSubId: null, name: 'x' },
  message: { type: 'conformance.test', severity: 'high', title: 'T', body: '**kalın** <b>' },
  arrange: {
    ok: () => undefined,
    transient: () => fake.nextOutcome({ status: 'transient', error: 'boom' }),
    rateLimited: (retryAfterMs) => fake.nextOutcome({ status: 'rate_limited', retryAfterMs }),
    permanent: () =>
      fake.nextOutcome({ status: 'permanent', error: 'gone', destinationBroken: true }),
    banned: () => fake.nextOutcome({ status: 'banned', error: 'banned' }),
  },
});
