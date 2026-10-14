import { customType, timestamp } from 'drizzle-orm/pg-core';

/** Postgres `bytea` carried as a Node Buffer (encrypted secrets). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** `timestamptz` column read and written as a JS Date. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Returns `list` unchanged, and fails to compile unless it names every member of `U` (and nothing else). Schema
 * files spell enum values out because drizzle-kit loads them as CommonJS and cannot import @owlwire/core values;
 * the type-only import keeps them in step with the core definitions.
 */
export const literalsOf =
  <U extends string>() =>
  <const L extends readonly U[]>(
    list: L & ([U] extends [L[number]] ? unknown : { missing: Exclude<U, L[number]> }),
  ): L =>
    list;
