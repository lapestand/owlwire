import { describe, expect, it } from 'vitest';
import { createClientIpResolver, parseTrustedProxies, TrustedProxyError } from './client-ip.js';

describe('parseTrustedProxies', () => {
  it('reads addresses and CIDR ranges, and treats empty as none', () => {
    expect(parseTrustedProxies(undefined)).toEqual([]);
    expect(parseTrustedProxies('  ')).toEqual([]);
    expect(parseTrustedProxies('10.0.0.5, 10.1.0.0/16,fd00::/8')).toEqual([
      '10.0.0.5',
      '10.1.0.0/16',
      'fd00::/8',
    ]);
  });

  it.each(['proxy.example', '10.0.0.0/33', '10.0.0.0/8/1', 'fd00::/129', '10.0.0.0/x'])(
    'rejects %s without echoing it',
    (bad) => {
      const run = () => parseTrustedProxies(`10.0.0.1, ${bad}`);
      expect(run).toThrow(TrustedProxyError);
      expect(run).toThrow('entry 2');
      try {
        run();
      } catch (err) {
        expect((err as Error).message).not.toContain(bad);
      }
    },
  );
});

describe('createClientIpResolver', () => {
  it('uses the socket address and ignores forwarded headers by default', () => {
    const resolve = createClientIpResolver([]);
    expect(resolve('203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
    expect(resolve('::ffff:203.0.113.9', null)).toBe('203.0.113.9');
    expect(resolve(undefined, '198.51.100.1')).toBeUndefined();
  });

  it('ignores X-Forwarded-For from a peer that is not a trusted proxy', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8']);
    expect(resolve('203.0.113.9', '198.51.100.1')).toBe('203.0.113.9');
  });

  it('walks X-Forwarded-For right to left past trusted proxies', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8', '192.0.2.1']);
    expect(resolve('10.0.0.2', '198.51.100.1')).toBe('198.51.100.1');
    // The client may prepend anything; the first untrusted hop from the right wins.
    expect(resolve('10.0.0.2', '1.2.3.4, 198.51.100.1, 192.0.2.1')).toBe('198.51.100.1');
    expect(resolve('::ffff:10.0.0.2', '198.51.100.1')).toBe('198.51.100.1');
    expect(resolve('10.0.0.2', null)).toBe('10.0.0.2');
  });

  it('stops at a hop that is not an address instead of trusting what is left of it', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8']);
    expect(resolve('10.0.0.2', 'not-an-ip, 10.0.0.3')).toBe('10.0.0.3');
    expect(resolve('10.0.0.2', '198.51.100.1, garbage')).toBe('10.0.0.2');
  });

  it('answers the leftmost hop when every hop is a trusted proxy', () => {
    const resolve = createClientIpResolver(['10.0.0.0/8']);
    expect(resolve('10.0.0.2', '10.0.0.4, 10.0.0.3')).toBe('10.0.0.4');
  });
});
