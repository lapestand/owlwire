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

const IPV4_WITH_PORT = /^([\d.]+):(\d{1,5})$/;
const BRACKETED_IPV6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/;

/**
 * Some gateways send hops with a port: `203.0.113.5:4711` or `[2001:db8::1]:4711`. The port is dropped only when
 * what remains is an address of the matching family and the port is in range; anything else is returned unchanged
 * and ends the walk as before.
 */
function withoutPort(hop: string): string {
  const v4 = IPV4_WITH_PORT.exec(hop);
  if (v4?.[1] && Number(v4[2]) <= 65535 && family(v4[1]) === 'ipv4') return v4[1];
  const v6 = BRACKETED_IPV6.exec(hop);
  if (v6?.[1] && Number(v6[2] ?? 0) <= 65535 && family(v6[1]) === 'ipv6') return v6[1];
  return hop;
}

/**
 * Parses a comma-separated list of proxy addresses and CIDR ranges (`10.0.0.5, 10.1.0.0/16, fd00::/8`). Empty or
 * unset means no proxy is trusted. IPv4-mapped entries (`::ffff:10.0.0.0/104`) are returned as their IPv4 form
 * (`10.0.0.0/8`). A `/0` range, which would trust every peer, is refused, also when it comes from a mapped range.
 */
export function parseTrustedProxies(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const entries = value
    .split(',')
    .map((e) => e.trim())
    .filter((e) => e !== '');
  return entries.map((entry, i) => {
    const invalid = () =>
      new TrustedProxyError(
        `OWLWIRE_TRUSTED_PROXIES entry ${i + 1} must be an IP address or a CIDR range other than /0`,
      );
    const [raw = '', prefix, ...rest] = entry.split('/');
    if (rest.length > 0 || !family(raw)) throw invalid();
    const address = unmap(raw);
    const mapped = family(raw) === 'ipv6' && family(address) === 'ipv4';
    if (prefix === undefined) return address;
    if (!/^\d{1,3}$/.test(prefix)) throw invalid();
    // A mapped range covers the IPv4 range whose prefix is 96 bits shorter.
    const bits = Number(prefix) - (mapped ? 96 : 0);
    const max = family(address) === 'ipv4' ? 32 : 128;
    if (bits < 1 || bits > max) throw invalid();
    return `${address}/${bits}`;
  });
}

export type ClientIpResolverOptions = {
  /**
   * Called at most once per resolver, the first time X-Forwarded-For arrives from a peer that is not a trusted proxy.
   * It gets no arguments, so nothing from the request can reach a log line through it.
   */
  onUntrustedForwarded?: () => void;
};

export type ClientIpResolver = (
  socketAddress: string | undefined,
  forwardedFor: string | null | undefined,
) => string | undefined;

/**
 * The client address for rate limiting. By default it is the TCP peer (the socket address) and forwarded headers are
 * ignored, since any client can send them. Only when the peer itself is one of the trusted proxies is
 * X-Forwarded-For read: its hops are walked right to left, trusted proxies are skipped, and the first untrusted hop
 * is the client. A hop may carry a port, which is dropped. A hop that is not an IP address ends the walk at the last
 * trusted hop, so a forged or malformed prefix can never pick the bucket.
 */
export function createClientIpResolver(
  trusted: readonly string[],
  options: ClientIpResolverOptions = {},
): ClientIpResolver {
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

  let reported = false;
  const reportUntrusted = () => {
    if (reported) return;
    reported = true;
    options.onUntrustedForwarded?.();
  };

  return (socketAddress, forwardedFor) => {
    if (!socketAddress) return undefined;
    const peer = unmap(socketAddress);
    if (!forwardedFor?.trim()) return peer;
    if (trusted.length === 0 || !isTrusted(peer)) {
      reportUntrusted();
      return peer;
    }
    const hops = forwardedFor.split(',').map((h) => unmap(withoutPort(h.trim())));
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
