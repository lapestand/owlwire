import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<true>();

/** Runs fn in a context where registration gates and verification emails are bypassed (CLI bootstrap only). */
export function runAsBootstrap<T>(fn: () => Promise<T>): Promise<T> {
  return storage.run(true, fn);
}

export function isBootstrap(): boolean {
  return storage.getStore() === true;
}
