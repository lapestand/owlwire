import type { DevDeliveryList } from '@owlwire/contracts';

export class DevApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'DevApiError';
    this.status = status;
  }
}

export async function fetchDeliveries(
  token: string,
  fetchImpl: typeof fetch = fetch,
  baseUrl = '',
): Promise<DevDeliveryList> {
  const res = await fetchImpl(`${baseUrl}/api/dev/deliveries?limit=100`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    let detail = res.statusText || `HTTP ${res.status}`;
    try {
      const problem = (await res.json()) as { detail?: string; title?: string };
      detail = problem.detail ?? problem.title ?? detail;
    } catch {
      // The body was not JSON (for example a proxy error page); keep the status text.
    }
    throw new DevApiError(res.status, detail);
  }
  return (await res.json()) as DevDeliveryList;
}
