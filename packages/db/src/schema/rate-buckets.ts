import { doublePrecision, pgTable, text } from 'drizzle-orm/pg-core';
import { tstz } from './types.js';

// Instance düzeyi altyapı: scope adları limit kovası kapsam adlarıdır (ör. 'platform:telegram:shared',
// 'conn:<id>', 'dest:<id>', 'quota:ws:<id>:deliveries'). workspace_id yok, RLS yok; kiracı verisi içermez.
// Repo fonksiyonları hız sınırlama eklendiğinde packages/db/src/repos/rate-buckets.ts içinde olacak.
export const rateBuckets = pgTable('rate_buckets', {
  scope: text('scope').primaryKey(),
  tokens: doublePrecision('tokens').notNull(),
  capacity: doublePrecision('capacity').notNull(),
  refillPerSec: doublePrecision('refill_per_sec').notNull(),
  updatedAt: tstz('updated_at').notNull().defaultNow(),
});
