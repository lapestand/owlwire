import type pg from 'pg';

export interface JobRow {
  task: string;
  payload: Record<string, unknown>;
  queue_name: string | null;
  run_at: Date;
  key: string | null;
}

/** Reads Graphile Worker's private tables (payload is not exposed by the public jobs view). */
export async function listJobs(pool: pg.Pool): Promise<JobRow[]> {
  const { rows } = await pool.query<JobRow>(`
    select t.identifier as task, j.payload, q.queue_name, j.run_at, j.key
    from graphile_worker._private_jobs j
    join graphile_worker._private_tasks t on t.id = j.task_id
    left join graphile_worker._private_job_queues q on q.id = j.job_queue_id
    order by j.id`);
  return rows;
}
