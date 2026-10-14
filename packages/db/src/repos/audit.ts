import { isUuid, newId } from '@owlwire/core';
import { and, desc, eq, isNull, lt, or, type SQL } from 'drizzle-orm';
import { RepoInputError } from '../errors.js';
import { auditLog } from '../schema/index.js';
import { SystemTx, type TenantTx } from '../scope.js';
import { now, q } from './context.js';

// Yeni denetim eylemleri bu diziye eklenir
// (aynı kalıp `<hedef>.<geçmiş zaman fiil>`, snake_case; eylem kolonu düz metin olduğundan migration gerekmez).
export const AUDIT_ACTIONS = [
  'workspace.created',
  'workspace.ownership_transferred',
  'keys.dek_created',
  'keys.kek_rotated',
  'keys.legacy_secrets_upgraded',
  'connection.created',
  'connection.config_updated',
  'connection.secret_viewed',
  'connection.deleted',
  'audience.created',
  'audience.deleted',
  'audience.members_changed',
  'app.created',
  'app.key_rotated',
  'app.approval_changed',
  'installation.created',
  'installation.revoked',
  'rule.created',
  'rule.updated',
  'rule.deleted',
  'member.added',
  'member.removed',
  'member.role_changed',
  'settings.updated',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// Yeni denetim hedef tipleri bu diziye eklenir.
export const AUDIT_TARGET_TYPES = [
  'workspace',
  'keys',
  'connection',
  'audience',
  'app',
  'installation',
  'rule',
  'member',
  'settings',
] as const;
export type AuditTargetType = (typeof AUDIT_TARGET_TYPES)[number];

export type AuditActor =
  | { kind: 'user'; userId: string }
  | { kind: 'installation'; installationId: string }
  | { kind: 'system' };

export const SYSTEM_ACTOR: AuditActor = Object.freeze({ kind: 'system' as const });

export interface AuditEntry {
  action: AuditAction;
  actor: AuditActor;
  targetType: AuditTargetType;
  targetId: string;
  data?: Record<string, unknown>;
}

export interface SystemAuditEntry extends AuditEntry {
  workspaceId: string | null;
}

export type AuditLogRow = typeof auditLog.$inferSelect;

export interface AuditCursor {
  createdAt: Date;
  id: string;
}

/**
 * Raised by the audit entry guard in `writeAudit` (secret-looking keys, non-JSON data, unknown action, malformed actor id).
 * List option errors (`limit`, `before` cursor) are `RepoInputError` instead.
 */
export class AuditDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditDataError';
  }
}

const SECRET_KEY_SUFFIXES = [
  'token',
  'secret',
  'password',
  'passwd',
  'config',
  'dek',
  'kek',
  'authorization',
  'cookie',
  'apikey',
  'privatekey',
  'webhookurl',
  'credential',
  'pem',
];

/** NFKC, lower case, then drop every character outside [a-z0-9] (separators, zero-width, dots). */
const normalizeKey = (key: string): string =>
  key
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/** Trailing plural/hash/value markers, stripped repeatedly so `tokens`, `password_hash` and `tokenHashes` match. */
const STRIPPED_SUFFIX = /(hashes|values|hash|value|s)$/;

const looksSecret = (normalized: string): boolean => {
  let n = normalized;
  for (;;) {
    if (SECRET_KEY_SUFFIXES.some((suffix) => n.endsWith(suffix))) return true;
    const stripped = n.replace(STRIPPED_SUFFIX, '');
    if (stripped === n) return false;
    n = stripped;
  }
};

/**
 * Denetim kaydına sır yazılmasını engeller: anahtar adı sır gibi görünen her alan reddedilir.
 * Yalnız anahtar adları incelenir; çağıran sırrı zararsız görünen bir anahtarın altına asla koymamalıdır.
 * Cyrillic homoglyph anahtarlar (ör. `tоken`) eşleşmez.
 */
export function assertAuditDataSafe(value: unknown, path = 'data'): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      assertAuditDataSafe(item, `${path}[${i}]`);
    });
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (looksSecret(normalizeKey(key))) {
        throw new AuditDataError(
          `${path}.${key} looks like a secret and must not be written to audit_log`,
        );
      }
      assertAuditDataSafe(child, `${path}.${key}`);
    }
  }
}

/**
 * Checks the JSON form that jsonb will actually store (toJSON, Map/Set and undefined are resolved first)
 * and returns that same value for insertion. Cycles, BigInt and extreme depth raise AuditDataError.
 */
function canonicalAuditData(data: Record<string, unknown>): Record<string, unknown> {
  let canonical: unknown;
  try {
    canonical = JSON.parse(JSON.stringify(data));
    assertAuditDataSafe(canonical);
  } catch (err) {
    if (err instanceof AuditDataError) throw err;
    throw new AuditDataError(
      `audit data is not serializable (${err instanceof Error ? err.name : 'error'})`,
    );
  }
  if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) {
    throw new AuditDataError('audit data must be a JSON object');
  }
  return canonical as Record<string, unknown>;
}

export async function writeAudit(t: TenantTx, entry: AuditEntry): Promise<void>;
export async function writeAudit(s: SystemTx, entry: SystemAuditEntry): Promise<void>;
export async function writeAudit(
  t: TenantTx | SystemTx,
  entry: AuditEntry & { workspaceId?: string | null },
): Promise<void> {
  if (!(AUDIT_ACTIONS as readonly string[]).includes(entry.action)) {
    throw new AuditDataError(`unknown audit action: ${entry.action}`);
  }
  const actorId =
    entry.actor.kind === 'user'
      ? entry.actor.userId
      : entry.actor.kind === 'installation'
        ? entry.actor.installationId
        : null;
  if (actorId !== null && !isUuid(actorId)) throw new AuditDataError('actor id must be a uuid');
  const data = canonicalAuditData(entry.data ?? {});
  const workspaceId = t instanceof SystemTx ? (entry.workspaceId ?? null) : t.workspaceId;
  await q(t)
    .insert(auditLog)
    .values({
      id: newId(),
      workspaceId,
      actorUserId: entry.actor.kind === 'user' ? entry.actor.userId : null,
      actorInstallationId: entry.actor.kind === 'installation' ? entry.actor.installationId : null,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      data,
      createdAt: now(t),
    });
}

export interface ListAuditOptions {
  limit?: number;
  before?: AuditCursor;
  action?: AuditAction;
}

async function listAudit(
  t: TenantTx | SystemTx,
  scopeCondition: SQL,
  opts: ListAuditOptions,
): Promise<AuditLogRow[]> {
  const limit = opts.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    throw new RepoInputError('audit', 'limit must be an integer between 1 and 200');
  }
  if (opts.before !== undefined) {
    if (opts.before === null || typeof opts.before !== 'object') {
      throw new RepoInputError('audit', 'before must be a cursor object');
    }
    const { createdAt, id } = opts.before;
    if (!(createdAt instanceof Date) || Number.isNaN(createdAt.getTime())) {
      throw new RepoInputError('audit', 'before.createdAt must be a valid Date');
    }
    if (!isUuid(id)) {
      throw new RepoInputError('audit', 'before.id must be a uuid');
    }
  }
  const conditions: SQL[] = [scopeCondition];
  if (opts.action) conditions.push(eq(auditLog.action, opts.action));
  if (opts.before) {
    const cursor = or(
      lt(auditLog.createdAt, opts.before.createdAt),
      and(eq(auditLog.createdAt, opts.before.createdAt), lt(auditLog.id, opts.before.id)),
    );
    if (cursor) conditions.push(cursor);
  }
  return q(t)
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(limit);
}

export async function listAuditLog(
  t: TenantTx,
  opts: ListAuditOptions = {},
): Promise<AuditLogRow[]> {
  return listAudit(t, eq(auditLog.workspaceId, t.workspaceId), opts);
}

/** Instance düzeyi kayıtlar (workspace_id null): keys.legacy_secrets_upgraded, settings.updated, ... */
export async function listSystemAuditLog(
  s: SystemTx,
  opts: ListAuditOptions = {},
): Promise<AuditLogRow[]> {
  return listAudit(s, isNull(auditLog.workspaceId), opts);
}
