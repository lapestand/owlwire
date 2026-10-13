import { customType, timestamp } from 'drizzle-orm/pg-core';

/** Postgres `bytea` carried as a Node Buffer (encrypted secrets). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/** `timestamptz` column read and written as a JS Date. */
export const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
