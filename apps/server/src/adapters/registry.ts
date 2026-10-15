import type { AdapterDeps, ChannelAdapter } from '@owlwire/adapter-sdk';
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

export function buildDefaultAdapters(
  config: Pick<ServerConfig, 'telegramBotToken'>,
  deps: AdapterDeps,
): ChannelAdapter[] {
  return [createTelegramAdapter(deps, { botToken: config.telegramBotToken })];
}
