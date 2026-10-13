export const KEY_BYTES = 32;

export interface Kek {
  version: number;
  key: Buffer;
}

export interface KekRing {
  current: Kek;
  previous: Kek | null;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function parseKek(base64: string, version: number): Kek {
  if (!Number.isInteger(version) || version < 1 || version > 0xffff) {
    throw new Error('KEK version must be an integer between 1 and 65535');
  }
  const trimmed = base64.trim();
  if (!BASE64.test(trimmed)) throw new Error('KEK must be base64 encoded');
  const key = Buffer.from(trimmed, 'base64');
  if (key.length !== KEY_BYTES) {
    throw new Error(`KEK must decode to ${KEY_BYTES} bytes, got ${key.length}`);
  }
  return { version, key };
}

export function parsePreviousKek(spec: string): Kek {
  const m = /^(\d+):(.+)$/.exec(spec.trim());
  if (!m) throw new Error('previous KEK must look like <version>:<base64>');
  return parseKek(m[2] ?? '', Number(m[1]));
}
