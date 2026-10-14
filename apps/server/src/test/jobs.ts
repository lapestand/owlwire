import { listQueuedJobs } from '@owlwire/testing';
import type pg from 'pg';

export interface JobRow {
  task: string;
  payload: Record<string, unknown>;
  queue_name: string | null;
  run_at: Date;
  key: string | null;
}

/** Geriye dönük uyumlu ad; Graphile'ın özel tablolarına erişim @owlwire/testing listQueuedJobs'tadır. */
export async function listJobs(pool: pg.Pool): Promise<JobRow[]> {
  return (await listQueuedJobs(pool)).map((j) => ({
    task: j.task,
    payload: j.payload,
    queue_name: j.queueName,
    run_at: j.runAt,
    key: j.key,
  }));
}
