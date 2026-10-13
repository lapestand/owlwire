export const DEFAULT_MAX_ATTEMPTS = 8;

const BASE_MS = 5_000;
const CAP_MS = 30 * 60_000;
const JITTER = 0.2;

/** min(2^attempts * 5s, 30min) +/- 20% jitter; rand() must return [0, 1). */
export function computeBackoffMs(attempts: number, rand: () => number): number {
  const exp = Math.min(2 ** Math.max(0, attempts) * BASE_MS, CAP_MS);
  const factor = 1 - JITTER + rand() * 2 * JITTER;
  return Math.round(exp * factor);
}
