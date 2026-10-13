import { sql } from 'drizzle-orm';
import { RepoInputError } from '../errors.js';
import { type SystemTx, TenantTx } from '../scope.js';
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

/** Payload alanı: TenantTx ile eklenen işin workspace'i (`enqueueJob` yazar; çağıran veremez). */
export const TENANT_JOB_PAYLOAD_KEY = '_ws';

/**
 * TenantTx ile eklenen işlerin kuyruk adı ve iş anahtarı bu ad alanına alınır: `w:<workspaceId>:<ad>`. Böylece bir
 * kiracı başka bir workspace'in işini anahtarla değiştiremez ve kuyruğuna iş sokamaz. Testler ve worker'lar beklenen
 * değeri bununla hesaplar (ör. `tenantJobName(ws, sendJobKey(id))`).
 */
export const tenantJobName = (workspaceId: string, name: string): string =>
  `w:${workspaceId}:${name}`;

export interface EnqueueOptions {
  queueName?: string;
  runAt?: Date;
  jobKey?: string;
  jobKeyMode?: 'replace' | 'preserve_run_at' | 'unsafe_dedupe';
  maxAttempts?: number;
}

/** JSON gidiş-dönüşü; sonuç düz bir nesne değilse (dizi, null, ilkel, serileştirilemez) RepoInputError. */
function canonicalPayload(payload: unknown): Record<string, unknown> {
  let parsed: unknown;
  try {
    const text = JSON.stringify(payload);
    parsed = text === undefined ? undefined : JSON.parse(text);
  } catch {
    throw new RepoInputError('job', 'payload is not JSON serializable');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RepoInputError('job', 'payload must serialize to a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/**
 * Çağıranın transaction'ında iş ekler (outbox): transaction geri alınırsa iş de eklenmez. Payload yalnız
 * kimlik taşımalıdır (sır, mesaj gövdesi ya da yapılandırma değil). `graphile_worker.add_job`'ın packages/db içindeki
 * tek çağrı yeridir (monorepo'da da tek: `apps/server/src/worker/jobs.ts` bunun üzerine ince sarmalayıcıdır, R45,
 * R62); tüm değerler parametre olarak bağlanır. Uygulama rolü Graphile tablolarına Görev 2'nin politikasıyla erişir.
 *
 * TenantTx ile: verilen `queueName` ve `jobKey` `tenantJobName(t.workspaceId, …)` ad alanına alınır ve payload'a
 * `_ws: t.workspaceId` eklenir (payload'da `_ws` varsa RepoInputError). Worker'lar `_ws`'yi işin kimliklerinden
 * çözülen workspace ile karşılaştırmalıdır. SystemTx ile adlar olduğu gibi kalır (yalnız instance düzeyi işler).
 */
export async function enqueueJob(
  t: TenantTx | SystemTx,
  name: JobName,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<void> {
  let queueName = opts.queueName ?? null;
  let jobKey = opts.jobKey ?? null;
  // Önce kanonik JSON: `toJSON` ya da benzeri bir dönüşüm `_ws` denetiminden sonra alan ekleyemez; saklanan
  // payload tam olarak denetlenen nesnedir.
  const body = canonicalPayload(payload);
  if (t instanceof TenantTx) {
    if (Object.hasOwn(body, TENANT_JOB_PAYLOAD_KEY)) {
      throw new RepoInputError('job', `payload must not contain ${TENANT_JOB_PAYLOAD_KEY}`);
    }
    if (queueName !== null) queueName = tenantJobName(t.workspaceId, queueName);
    if (jobKey !== null) jobKey = tenantJobName(t.workspaceId, jobKey);
    body[TENANT_JOB_PAYLOAD_KEY] = t.workspaceId;
  }
  await q(t).execute(sql`select graphile_worker.add_job(
    ${name}::text,
    ${JSON.stringify(body)}::json,
    queue_name => ${queueName}::text,
    run_at => ${opts.runAt ?? null}::timestamptz,
    max_attempts => ${opts.maxAttempts ?? null}::int,
    job_key => ${jobKey}::text,
    job_key_mode => coalesce(${opts.jobKeyMode ?? null}::text, 'replace')
  )`);
}
