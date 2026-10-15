import type pg from 'pg';
import { waitFor } from './wait.js';

/** A statement run inside the lock-holding transaction (owner role, so RLS does not apply). */
export interface LockedChange {
  sql: string;
  params: unknown[];
}

/**
 * Runs `fire` while another transaction holds the workspace row lock (in the same mode as the server's write lock)
 * and has already made `change` (not yet committed). The request passes the access check on the committed state,
 * then waits for the lock; the change is committed only once the request is seen waiting on it, so the write must
 * decide on the state after the change.
 */
export async function underWorkspaceLock(
  pool: pg.Pool,
  ws: string,
  change: LockedChange,
  fire: () => Promise<Response>,
): Promise<Response> {
  const client = await pool.connect();
  let pending: Promise<Response> | undefined;
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM workspaces WHERE id = $1 FOR NO KEY UPDATE', [ws]);
    await client.query(change.sql, change.params);
    const { rows } = await client.query<{ xid: string }>(
      'SELECT pg_current_xact_id()::text AS xid',
    );
    const xid = rows[0]?.xid ?? '';
    pending = fire();
    await waitFor(
      async () => {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_locks WHERE locktype = 'transactionid' AND NOT granted AND transactionid::text = $1`,
          [xid],
        );
        return (waiting.rowCount ?? 0) > 0;
      },
      10_000,
      20,
    );
    await client.query('COMMIT');
    return await pending;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    // The rollback releases the request waiting on the lock; settle it so it is not left running past the test.
    if (pending) await pending.catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const setRole = (ws: string, userId: string, role: string): LockedChange => ({
  sql: 'UPDATE memberships SET role = $3 WHERE workspace_id = $1 AND user_id = $2',
  params: [ws, userId, role],
});

export const dropMember = (ws: string, userId: string): LockedChange => ({
  sql: 'DELETE FROM memberships WHERE workspace_id = $1 AND user_id = $2',
  params: [ws, userId],
});
