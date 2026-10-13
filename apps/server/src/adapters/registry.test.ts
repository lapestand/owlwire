import { type AdapterDeps, createFakeAdapter } from '@owlwire/adapter-sdk';
import { describe, expect, it, vi } from 'vitest';
import { buildDefaultAdapters, createAdapterRegistry } from './registry.js';

function deps(): AdapterDeps & { info: ReturnType<typeof vi.fn> } {
  const info = vi.fn();
  const noop = () => {};
  return {
    info,
    logger: { info, warn: noop, error: noop, debug: noop },
    fetch: globalThis.fetch,
    clock: { now: () => new Date() },
  };
}

describe('adapter registry', () => {
  it('registers telegram by default and the fake adapter only when enabled', () => {
    const plain = createAdapterRegistry(
      buildDefaultAdapters({ telegramBotToken: null, devFakeAdapter: false }, deps()),
    );
    expect(plain.list().map((a) => a.platform)).toEqual(['telegram']);
    expect(plain.get('webhook')).toBeUndefined();

    const dev = createAdapterRegistry(
      buildDefaultAdapters({ telegramBotToken: null, devFakeAdapter: true }, deps()),
    );
    expect(dev.get('webhook')?.platform).toBe('webhook');
  });

  it('logs every fake adapter send', async () => {
    const d = deps();
    const registry = createAdapterRegistry(
      buildDefaultAdapters({ telegramBotToken: null, devFakeAdapter: true }, d),
    );
    const fake = registry.get('webhook');
    const outcome = await fake?.send(
      { id: 'c', workspaceId: 'w', platform: 'webhook', kind: 'webhook', config: {} },
      { id: 'd', kind: 'webhook', externalId: 'x', externalSubId: null, name: 'x' },
      { text: 'hello', truncated: false },
      {},
    );
    expect(outcome?.status).toBe('ok');
    expect(d.info).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'hello', connectionId: 'c' }),
      'fake adapter send',
    );
  });

  it('rejects two adapters for the same platform', () => {
    expect(() => createAdapterRegistry([createFakeAdapter(), createFakeAdapter()])).toThrow(
      /duplicate adapter/,
    );
  });
});
