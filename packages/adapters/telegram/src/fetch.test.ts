import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { withNativeAbortSignal } from './fetch.js';

/** Mimics a polyfilled AbortSignal (e.g. grammY's abort-controller): not a native instance. */
class ForeignSignal extends EventTarget {
  aborted = false;
  abort() {
    this.aborted = true;
    this.dispatchEvent(new Event('abort'));
  }
}

let server: Server | undefined;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function hangingServer(): Promise<{ url: string; requested: Promise<void> }> {
  let markRequested: () => void = () => {};
  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  server = createServer(() => markRequested());
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/`, requested };
}

const foreign = (s: ForeignSignal) => s as unknown as AbortSignal;

describe('withNativeAbortSignal', () => {
  it('lets the native fetch accept a foreign abort signal', async () => {
    server = createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const fetchFn = withNativeAbortSignal(globalThis.fetch);
    const res = await fetchFn(`http://127.0.0.1:${port}/`, {
      signal: foreign(new ForeignSignal()),
    });
    expect(await res.text()).toBe('ok');
  });

  it('forwards an abort of the foreign signal to the in-flight request', async () => {
    const { url, requested } = await hangingServer();
    const signal = new ForeignSignal();
    const pending = withNativeAbortSignal(globalThis.fetch)(url, { signal: foreign(signal) });
    await requested;
    signal.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects at once when the foreign signal is already aborted', async () => {
    const { url } = await hangingServer();
    const signal = new ForeignSignal();
    signal.abort();
    await expect(
      withNativeAbortSignal(globalThis.fetch)(url, { signal: foreign(signal) }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('passes native signals and requests without a signal through unchanged', async () => {
    const seen: Array<RequestInit | undefined> = [];
    const inner = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init);
      return new Response('x');
    }) as typeof fetch;
    const native = new AbortController().signal;
    const init = { signal: native };
    await withNativeAbortSignal(inner)('http://x/', init);
    await withNativeAbortSignal(inner)('http://x/');
    expect(seen[0]).toBe(init);
    expect(seen[1]).toBeUndefined();
  });
});
