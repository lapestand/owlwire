import { isUuid } from '@owlwire/core';
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditCursor,
  type AuditLogRow,
  listAuditLog,
  tenantScope,
  withTenant,
} from '@owlwire/db';
import type { BaseDeps } from '../base-deps.js';
import { ProblemError } from '../errors.js';

/** Fixed details of the 422s below, snake_case like every detail a client branches on; the value is never echoed. */
const INVALID_CURSOR_DETAIL = 'invalid_cursor';
const UNKNOWN_AUDIT_ACTION_DETAIL = 'unknown_audit_action';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** base64url("<createdAt ISO>|<id>"): opaque to clients, and the exact position of the last row they saw. */
export function encodeAuditCursor(c: AuditCursor): string {
  return Buffer.from(`${c.createdAt.toISOString()}|${c.id}`, 'utf8').toString('base64url');
}

/**
 * The cursor encodeAuditCursor wrote, or null for anything else: characters outside the base64url alphabet, a missing
 * or extra field, an id that is not a UUID, or a time not written in the canonical ISO form encodeAuditCursor uses.
 */
export function decodeAuditCursor(value: string): AuditCursor | null {
  if (!BASE64URL.test(value)) return null;
  const [iso, id, extra] = Buffer.from(value, 'base64url').toString('utf8').split('|');
  if (iso === undefined || id === undefined || extra !== undefined || !isUuid(id)) return null;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) return null;
  return { createdAt, id };
}

const isAuditAction = (value: string): value is AuditAction =>
  (AUDIT_ACTIONS as readonly string[]).includes(value);

/**
 * One page of the workspace's audit log, newest first. Reads one row more than asked to learn whether another page
 * exists; nextCursor points at the last row returned. A malformed cursor or an unknown action is 422.
 */
export async function listWorkspaceAudit(
  deps: Pick<BaseDeps, 'db'>,
  workspaceId: string,
  query: { limit: number; cursor?: string | undefined; action?: string | undefined },
): Promise<{ items: AuditLogRow[]; nextCursor: string | null }> {
  const before = query.cursor === undefined ? undefined : decodeAuditCursor(query.cursor);
  if (before === null) throw new ProblemError(422, 'validation_failed', INVALID_CURSOR_DETAIL);
  const action = query.action;
  if (action !== undefined && !isAuditAction(action)) {
    throw new ProblemError(422, 'validation_failed', UNKNOWN_AUDIT_ACTION_DETAIL);
  }
  const rows = await withTenant(deps.db, tenantScope(workspaceId), (t) =>
    listAuditLog(t, {
      limit: query.limit + 1,
      ...(before ? { before } : {}),
      ...(action ? { action } : {}),
    }),
  );
  const items = rows.slice(0, query.limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > query.limit && last
        ? encodeAuditCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}
