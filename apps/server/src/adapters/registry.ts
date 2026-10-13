import { type AdapterDeps, type ChannelAdapter, createFakeAdapter } from '@owlwire/adapter-sdk';
import { createTelegramAdapter } from '@owlwire/adapter-telegram';
import type { ServerConfig } from '../config/load.js';

export interface AdapterRegistry {
  get(platform: string): ChannelAdapter | undefined;
  list(): ChannelAdapter[];
}

export function createAdapterRegistry(adapters: ChannelAdapter[]): AdapterRegistry {
  const byPlatform = new Map<string, ChannelAdapter>();
  for (const adapter of adapters) {
    if (byPlatform.has(adapter.platform)) {
      throw new Error(`duplicate adapter for platform ${adapter.platform}`);
    }
    byPlatform.set(adapter.platform, adapter);
  }
  return {
    get: (platform) => byPlatform.get(platform),
    list: () => [...byPlatform.values()],
  };
}

/**
 * P0 only: fake adapter for platform "webhook" that logs every message it "sends".
 * Removed in P1b together with OWLWIRE_DEV_FAKE_ADAPTER; P1j registers the real webhook-out
 * adapter under platform = 'webhook' (R48).
 */
function createLoggingFakeAdapter(deps: AdapterDeps): ChannelAdapter {
  const fake = createFakeAdapter('webhook');
  return {
    ...fake,
    async send(conn, dest, rendered, opts) {
      deps.logger.info(
        { connectionId: conn.id, destination: dest.externalId, text: rendered.text },
        'fake adapter send',
      );
      return fake.send(conn, dest, rendered, opts);
    },
  };
}

export function buildDefaultAdapters(
  config: Pick<ServerConfig, 'telegramBotToken' | 'devFakeAdapter'>,
  deps: AdapterDeps,
): ChannelAdapter[] {
  const adapters: ChannelAdapter[] = [
    createTelegramAdapter(deps, { botToken: config.telegramBotToken }),
  ];
  if (config.devFakeAdapter) adapters.push(createLoggingFakeAdapter(deps));
  return adapters;
}
