import { renderMessagePlain } from './render.js';
import type {
  Capabilities,
  ChannelAdapter,
  DestinationRef,
  Platform,
  RenderedMessage,
  SendOutcome,
} from './types.js';

export const FAKE_CAPABILITIES: Capabilities = {
  formatting: 'plain',
  maxBodyLength: 4000,
  images: false,
  typingIndicator: false,
  dm: true,
  threads: false,
};

export type FakeAdapter = ChannelAdapter & {
  sent: Array<{ dest: DestinationRef; rendered: RenderedMessage }>;
  nextOutcome(o: SendOutcome): void;
};

export function createFakeAdapter(platform: Platform = 'webhook'): FakeAdapter {
  const sent: FakeAdapter['sent'] = [];
  const queue: SendOutcome[] = [];
  let counter = 0;
  return {
    platform,
    sent,
    nextOutcome(o) {
      queue.push(o);
    },
    capabilities: () => FAKE_CAPABILITIES,
    validateConnection: async () => ({ status: 'active' }),
    discoverDestinations: async () => [],
    render: (msg, _dest, caps) => renderMessagePlain(msg, caps.maxBodyLength),
    async send(_conn, dest, rendered) {
      const queued = queue.shift();
      if (queued && queued.status !== 'ok') return queued;
      counter += 1;
      sent.push({ dest, rendered });
      return queued ?? { status: 'ok', platformMessageId: `fake-${counter}` };
    },
    health: async () => ({ status: 'active' }),
    platformLimits: () => ({}),
  };
}
