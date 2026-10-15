import { describe, expect, it } from 'vitest';
import { decodeAuditCursor, encodeAuditCursor } from './audit.js';

describe('audit cursor', () => {
  it('round-trips createdAt and id', () => {
    const cursor = {
      createdAt: new Date('2026-10-12T09:30:00.123Z'),
      id: '0192f0a0-0000-7000-8000-00000000000a',
    };
    const encoded = encodeAuditCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeAuditCursor(encoded)).toEqual(cursor);
  });

  it('rejects garbage', () => {
    for (const bad of [
      '',
      'not-base64!',
      Buffer.from('no-separator').toString('base64url'),
      Buffer.from('2026-13-99|x').toString('base64url'),
    ]) {
      expect(decodeAuditCursor(bad)).toBeNull();
    }
  });

  it('rejects cursors it would never have produced', () => {
    const id = '0192f0a0-0000-7000-8000-00000000000a';
    const enc = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    for (const bad of [
      // a date the parser accepts but encodeAuditCursor never writes
      enc(`2026-10-12|${id}`),
      enc(`Mon, 12 Oct 2026 09:30:00 GMT|${id}`),
      // a third field
      enc(`2026-10-12T09:30:00.123Z|${id}|extra`),
      // standard base64 padding and characters outside the base64url alphabet
      `${enc(`2026-10-12T09:30:00.123Z|${id}`)}=`,
      enc(`2026-10-12T09:30:00.123Z|${id}`).replace(/^./, '+'),
    ]) {
      expect(decodeAuditCursor(bad)).toBeNull();
    }
  });
});
