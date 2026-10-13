/** The parts of a (possibly polyfilled) abort signal the bridge relies on. */
interface AbortSignalLike {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
}

/**
 * grammY creates its request signals with the `abort-controller` polyfill, and Node's
 * native fetch (undici) rejects any `init.signal` that is not a native AbortSignal
 * ("Expected signal to be an instance of AbortSignal"). This wrapper keeps the injected
 * fetch but swaps a foreign signal for a native one that follows it, so grammY's
 * timeout and cancellation still abort the underlying request.
 */
export function withNativeAbortSignal(fetchFn: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignalLike | null | undefined;
    if (!signal || signal instanceof AbortSignal) return fetchFn(input, init);
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    // Kept until abort (not removed when headers arrive) so a timeout while the body is
    // still streaming also cancels it; grammY creates a fresh signal per request.
    else signal.addEventListener('abort', abort, { once: true });
    return fetchFn(input, { ...init, signal: controller.signal });
  }) as typeof fetch;
}
