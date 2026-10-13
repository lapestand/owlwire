import { v7 } from 'uuid';

export function newId(): string {
  return v7();
}

/** Canonical textual UUID (any version, either case), the only id form the database's `uuid` columns accept. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The nil UUID; the starting cursor for id-ordered paging. */
export const ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
