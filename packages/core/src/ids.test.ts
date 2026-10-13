import { describe, expect, it } from 'vitest';
import { isUuid, newId, ZERO_UUID } from './ids.js';

describe('newId', () => {
  it('produces UUIDv7 strings', () => {
    expect(newId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('is unique and sorts in generation order', () => {
    const ids = Array.from({ length: 1000 }, () => newId());
    expect(new Set(ids).size).toBe(1000);
    expect([...ids].sort()).toEqual(ids);
  });
});

describe('isUuid', () => {
  it('accepts canonical uuids in either case and rejects everything else', () => {
    expect(isUuid(newId())).toBe(true);
    expect(isUuid(newId().toUpperCase())).toBe(true);
    expect(isUuid(ZERO_UUID)).toBe(true);
    for (const bad of ['not-a-uuid', '', ` ${ZERO_UUID}`, `${ZERO_UUID}0`, 42, null, undefined]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});
