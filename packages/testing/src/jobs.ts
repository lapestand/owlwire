import type pg from 'pg';

export interface QueuedJob {
  task: string;
  payload: Record<string, unknown>;
  queueName: string | null;
  runAt: Date;
  key: string | null;
}

/**
 * Kuyruktaki Graphile Worker işleri (yalnız testler). Genel `graphile_worker.jobs` görünümü payload vermez
 * (Graphile Worker 0.18); payload için `_private_jobs`'a tek erişim burasıdır — Graphile şeması değişirse
 * yalnız bu sorgu güncellenir. Kuyruk ve anahtar değerleri @owlwire/db kuyruk/anahtar yardımcılarıyla karşılaştırılır.
 */
export async function listQueuedJobs(pool: pg.Pool): Promise<QueuedJob[]> {
  const { rows } = await pool.query<QueuedJob>(`
    select j.task_identifier as task, p.payload, j.queue_name as "queueName", j.run_at as "runAt", j.key
    from graphile_worker.jobs j
    join graphile_worker._private_jobs p on p.id = j.id
    order by j.id`);
  return rows;
}
