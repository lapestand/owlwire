import { type AdapterDeps, createFakeAdapter } from '@owlwire/adapter-sdk';
import { describe, expect, it } from 'vitest';
import { buildDefaultAdapters, createAdapterRegistry } from './registry.js';

function deps(): AdapterDeps {
  const noop = () => {};
  return {
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    fetch: globalThis.fetch,
    clock: { now: () => new Date() },
  };
}

describe('adapter registry', () => {
  it('registers only telegram by default', () => {
    const registry = createAdapterRegistry(
      buildDefaultAdapters({ telegramBotToken: null }, deps()),
    );
    expect(registry.list().map((a) => a.platform)).toEqual(['telegram']);
    expect(registry.get('webhook')).toBeUndefined();
  });

  it('rejects two adapters for the same platform', () => {
    expect(() => createAdapterRegistry([createFakeAdapter(), createFakeAdapter()])).toThrow(
      /duplicate adapter/,
    );
  });

  it('registers adapters with open platform ids', () => {
    const a = createFakeAdapter('fake-a');
    const b = createFakeAdapter('fake-b');
    const registry = createAdapterRegistry([a, b]);
    expect(registry.get('fake-a')).toBe(a);
    expect(registry.get('fake-b')).toBe(b);
  });

  it('rejects an adapter with an invalid platform id', () => {
    expect(() => createAdapterRegistry([createFakeAdapter('Fake-A')])).toThrow(
      /invalid platform id Fake-A/,
    );
  });
});
