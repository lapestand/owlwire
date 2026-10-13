import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseKek, parsePreviousKek } from './keys.js';

const b64 = randomBytes(32).toString('base64');

describe('parseKek', () => {
  it('accepts 32 bytes of base64 and a version', () => {
    const kek = parseKek(b64, 3);
    expect(kek.version).toBe(3);
    expect(kek.key).toHaveLength(32);
  });

  it('rejects wrong lengths, non-base64 input and bad versions without echoing the key', () => {
    const short = randomBytes(16).toString('base64');
    expect(() => parseKek(short, 1)).toThrow(/32 bytes/);
    expect(() => parseKek(short, 1)).not.toThrow(short);
    expect(() => parseKek('not base64 !!', 1)).toThrow(/base64/);
    expect(() => parseKek(b64, 0)).toThrow(/version/);
    expect(() => parseKek(b64, 70000)).toThrow(/version/);
  });
});

describe('parsePreviousKek', () => {
  it('parses "<version>:<base64>"', () => {
    expect(parsePreviousKek(`2:${b64}`).version).toBe(2);
  });

  it('rejects malformed specs', () => {
    expect(() => parsePreviousKek(b64)).toThrow(/<version>:<base64>/);
    expect(() => parsePreviousKek(`x:${b64}`)).toThrow(/<version>:<base64>/);
  });
});
