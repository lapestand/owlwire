import { describe, expect, it } from 'vitest';
import { GENERIC_TYPE_KEY, RESERVED_TYPE_PREFIX } from './catalog.js';

describe('catalog constants', () => {
  it('names the generic type and the reserved prefix', () => {
    expect(GENERIC_TYPE_KEY).toBe('generic');
    expect(RESERVED_TYPE_PREFIX).toBe('owlwire.');
    expect('owlwire.digest'.startsWith(RESERVED_TYPE_PREFIX)).toBe(true);
  });
});
