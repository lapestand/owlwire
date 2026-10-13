import { sql } from 'drizzle-orm';
import type { SystemTx, TenantTx } from '../scope.js';
import { q } from './context.js';

/** Sözleşme §9 görev adları (sahip P1a; sahip planlar burada tanımlı adı kullanır — R44). */
export const JOB_NAMES = [
  'route_event',
  'send_delivery',
  'send_digest',
  'health_check_connection',
  'health_check_all',
  'retention_sweep',
  'send_admin_notification',
  'purge_workspace',
  'status_webhook',
  'expire_link_requests',
  'send_email_consent',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Kuyruk adı ve iş anahtarı kalıpları tek yerde (Sözleşme §9, R45, R62). */
export const routeQueue = (installationId: string): string => `route:${installationId}`;
export const connectionQueue = (connectionId: string): string => `conn:${connectionId}`;
export const sendJobKey = (deliveryId: string): string => `send:${deliveryId}`;
export const digestJobKey = (destinationId: string, windowStart: Date): string =>
  `digest:${destinationId}:${windowStart.getTime()}`;
export const healthJobKey = (connectionId: string): string => `health:${connectionId}`;

export interface EnqueueOptions {
  queueName?: string;
  runAt?: Date;
  jobKey?: string;
  jobKeyMode?: 'replace' | 'preserve_run_at' | 'unsafe_dedupe';
  maxAttempts?: number;
}

/**
 * Çağıranın transaction'ında iş ekler (outbox): transaction geri alınırsa iş de eklenmez. Payload yalnız
 * kimlik taşımalıdır (sır, mesaj gövdesi ya da yapılandırma değil). `graphile_worker.add_job`'ın kod tabanındaki
 * tek çağrı yeridir; tüm değerler parametre olarak bağlanır. Uygulama rolü Graphile tablolarına Görev 2'nin
 * politikasıyla erişir.
 */
export async function enqueueJob(
  t: TenantTx | SystemTx,
  name: JobName,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<void> {
  await q(t).execute(sql`select graphile_worker.add_job(
    ${name}::text,
    ${JSON.stringify(payload)}::json,
    queue_name => ${opts.queueName ?? null}::text,
    run_at => ${opts.runAt ?? null}::timestamptz,
    max_attempts => ${opts.maxAttempts ?? null}::int,
    job_key => ${opts.jobKey ?? null}::text,
    job_key_mode => coalesce(${opts.jobKeyMode ?? null}::text, 'replace')
  )`);
}
