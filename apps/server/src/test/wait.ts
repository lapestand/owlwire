export async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs} ms`);
}
