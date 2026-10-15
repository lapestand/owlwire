import { BlockList, isIP } from 'node:net';

/** An OWLWIRE_TRUSTED_PROXIES entry that is not an IP address or CIDR range. Names the position, never the value. */
export class TrustedProxyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedProxyError';
  }
}

/** `::ffff:192.0.2.1` and `192.0.2.1` are the same client. */
function unmap(address: string): string {
  const lower = address.toLowerCase();
  if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) return lower.slice(7);
  return lower;
}

function family(address: string): 'ipv4' | 'ipv6' | null {
  const kind = isIP(address);
  return kind === 4 ? 'ipv4' : kind === 6 ? 'ipv6' : null;
}

/**
 * Parses a comma-separated list of proxy addresses and CIDR ranges (`10.0.0.5, 10.1.0.0/16, fd00::/8`). Empty or
 * unset means no proxy is trusted.
 */
export function parseTrustedProxies(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  entries.forEach((entry, i) => {
    const [address = '', prefix, ...rest] = entry.split('/');
    const kind = family(address);
    const max = kind === 'ipv4' ? 32 : 128;
    const validPrefix = prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= max);
    if (!kind || rest.length > 0 || !validPrefix) {
      throw new TrustedProxyError(
        `OWLWIRE_TRUSTED_PROXIES entry ${i + 1} must be an IP address or a CIDR range`,
      );
    }
  });
  return entries;
}

export type ClientIpResolver = (
  socketAddress: string | undefined,
  forwardedFor: string | null | undefined,
) => string | undefined;

/**
 * The client address for rate limiting. By default it is the TCP peer (the socket address) and forwarded headers are
 * ignored, since any client can send them. Only when the peer itself is one of the trusted proxies is
 * X-Forwarded-For read: its hops are walked right to left, trusted proxies are skipped, and the first untrusted hop
 * is the client. A hop that is not an IP address ends the walk at the last trusted hop, so a forged or malformed
 * prefix can never pick the bucket.
 */
export function createClientIpResolver(trusted: readonly string[]): ClientIpResolver {
  const list = new BlockList();
  for (const entry of trusted) {
    const [address = '', prefix] = entry.split('/');
    const kind = family(unmap(address));
    if (!kind) continue;
    if (prefix === undefined) list.addAddress(unmap(address), kind);
    else list.addSubnet(unmap(address), Number(prefix), kind);
  }
  const isTrusted = (address: string): boolean => {
    const kind = family(address);
    return kind !== null && list.check(address, kind);
  };

  return (socketAddress, forwardedFor) => {
    if (!socketAddress) return undefined;
    const peer = unmap(socketAddress);
    if (trusted.length === 0 || !isTrusted(peer) || !forwardedFor) return peer;
    const hops = forwardedFor.split(',').map((h) => unmap(h.trim()));
    let client = peer;
    for (let i = hops.length - 1; i >= 0; i--) {
      const hop = hops[i] ?? '';
      if (!family(hop)) return client;
      client = hop;
      if (!isTrusted(hop)) return hop;
    }
    return client;
  };
}
