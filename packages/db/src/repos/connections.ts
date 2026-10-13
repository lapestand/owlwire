import { newId } from '@owlwire/core';
import { and, asc, eq, getTableColumns, inArray, isNull } from 'drizzle-orm';
import { LegacySecretError, mapPgErrors, RepoNotFoundError } from '../errors.js';
import {
  audienceMembers,
  connections,
  deliveries,
  destinations,
  ruleTargets,
} from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { openConnectionConfig, sealConnectionConfig } from './connection-crypto.js';
import { now, q } from './context.js';

type ConnectionSelect = typeof connections.$inferSelect;
/** Şifreli yapılandırma satır tipinde yoktur; yalnız `readConnectionConfig` ile, amaç belirtilerek okunur. */
export type ConnectionRow = Omit<ConnectionSelect, 'configEnc' | 'configEncScheme'>;
export type ConnectionStatus = NonNullable<ConnectionSelect['status']>;

const {
  configEnc: _configEnc,
  configEncScheme: _configEncScheme,
  ...publicColumns
} = getTableColumns(connections);

export interface CreateConnectionInput {
  platform: ConnectionSelect['platform'];
  kind: ConnectionSelect['kind'];
  displayName: string;
  config: Record<string, unknown> | null;
  pacing?: ConnectionSelect['pacing'];
}

export type ReadConfigOptions = { purpose: 'send' } | { purpose: 'reveal'; actor: AuditActor };

/** R101: yumuşak silinmiş bağlantılar tenant fonksiyonlarında yoktur. */
const byId = (t: TenantTx, id: string) =>
  and(
    eq(connections.workspaceId, t.workspaceId),
    eq(connections.id, id),
    isNull(connections.deletedAt),
  );

export async function createConnection(
  t: TenantTx,
  input: CreateConnectionInput,
  actor: AuditActor,
): Promise<ConnectionRow> {
  const id = newId();
  const ts = now(t);
  const configEnc = input.config === null ? null : await sealConnectionConfig(t, id, input.config);
  const rows = await mapPgErrors('connection', id, () =>
    q(t)
      .insert(connections)
      .values({
        id,
        workspaceId: t.workspaceId,
        platform: input.platform,
        kind: input.kind,
        displayName: input.displayName,
        configEnc,
        configEncScheme: 'dek_v1',
        pacing: input.pacing ?? null,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning(publicColumns),
  );
  const row = rows[0];
  if (!row) throw new Error('connection insert returned no row');
  await writeAudit(t, {
    action: 'connection.created',
    actor,
    targetType: 'connection',
    targetId: id,
    data: { platform: input.platform, kind: input.kind },
  });
  return row;
}

export async function getConnection(t: TenantTx, id: string): Promise<ConnectionRow | null> {
  const rows = await q(t).select(publicColumns).from(connections).where(byId(t, id));
  return rows[0] ?? null;
}

export async function listConnections(t: TenantTx): Promise<ConnectionRow[]> {
  return q(t)
    .select(publicColumns)
    .from(connections)
    .where(and(eq(connections.workspaceId, t.workspaceId), isNull(connections.deletedAt)))
    .orderBy(asc(connections.createdAt), asc(connections.id));
}

/**
 * `send`: gönderim yolu, denetim yazılmaz. `reveal`: yapılandırma bir kişiye gösterilir, `connection.secret_viewed`
 * denetimi aynı transaction'da yazılır. Yapılandırması olmayan bağlantı null; P0 şeması (`kek_v0`) LegacySecretError.
 */
export async function readConnectionConfig(
  t: TenantTx,
  id: string,
  opts: ReadConfigOptions,
): Promise<Record<string, unknown> | null> {
  const rows = await q(t)
    .select({ configEnc: connections.configEnc, configEncScheme: connections.configEncScheme })
    .from(connections)
    .where(byId(t, id));
  const row = rows[0];
  if (!row) throw new RepoNotFoundError('connection', id);
  if (row.configEnc === null) return null;
  if (row.configEncScheme !== 'dek_v1') throw new LegacySecretError(id);
  const config = await openConnectionConfig(t, id, row.configEnc);
  if (opts.purpose === 'reveal') {
    await writeAudit(t, {
      action: 'connection.secret_viewed',
      actor: opts.actor,
      targetType: 'connection',
      targetId: id,
    });
  }
  return config;
}

/** Yapılandırmayı yeniden mühürler (eski `kek_v0` satırı da `dek_v1`'e geçer); denetime yalnız alan adları yazılır. */
export async function updateConnectionConfig(
  t: TenantTx,
  id: string,
  config: Record<string, unknown> | null,
  actor: AuditActor,
): Promise<void> {
  const configEnc = config === null ? null : await sealConnectionConfig(t, id, config);
  const rows = await q(t)
    .update(connections)
    .set({ configEnc, configEncScheme: 'dek_v1', updatedAt: now(t) })
    .where(byId(t, id))
    .returning({ id: connections.id });
  if (!rows[0]) throw new RepoNotFoundError('connection', id);
  await writeAudit(t, {
    action: 'connection.config_updated',
    actor,
    targetType: 'connection',
    targetId: id,
    data: { fieldNames: Object.keys(config ?? {}).sort() },
  });
}

export async function updateConnectionStatus(
  t: TenantTx,
  id: string,
  status: ConnectionStatus,
  reason: string | null,
): Promise<void> {
  const rows = await q(t)
    .update(connections)
    .set({ status, statusReason: reason, updatedAt: now(t) })
    .where(byId(t, id))
    .returning({ id: connections.id });
  if (!rows[0]) throw new RepoNotFoundError('connection', id);
}

/**
 * Sözleşme v2.1 R101 — yumuşak silme: bağlantı ve hedefleri `deleted_at` alır, o hedeflere ait kural hedefleri ve
 * alıcı listesi üyelikleri silinir; teslimat geçmişi (deliveries, delivery_attempts) korunur. Hedefi olan bağlantı
 * da silinir. v2.2 R125: bağlantının `pending|scheduled` teslimatları aynı transaction'da başarısız işaretlenir.
 */
export async function deleteConnection(t: TenantTx, id: string, actor: AuditActor): Promise<void> {
  const ts = now(t);
  const rows = await q(t)
    .update(connections)
    .set({ deletedAt: ts, updatedAt: ts })
    .where(byId(t, id))
    .returning({ platform: connections.platform });
  const row = rows[0];
  if (!row) throw new RepoNotFoundError('connection', id);
  const ownDestinations = q(t)
    .select({ id: destinations.id })
    .from(destinations)
    .where(and(eq(destinations.workspaceId, t.workspaceId), eq(destinations.connectionId, id)));
  await q(t)
    .delete(ruleTargets)
    .where(
      and(
        eq(ruleTargets.workspaceId, t.workspaceId),
        inArray(ruleTargets.destinationId, ownDestinations),
      ),
    );
  await q(t)
    .delete(audienceMembers)
    .where(
      and(
        eq(audienceMembers.workspaceId, t.workspaceId),
        inArray(audienceMembers.destinationId, ownDestinations),
      ),
    );
  await q(t)
    .update(destinations)
    .set({ deletedAt: ts })
    .where(
      and(
        eq(destinations.workspaceId, t.workspaceId),
        eq(destinations.connectionId, id),
        isNull(destinations.deletedAt),
      ),
    );
  // v2.2 R125: kuyruğu olmayan (park edilmiş) teslimatlar asılı kalmasın — silme anında başarısız işaretlenir.
  await q(t)
    .update(deliveries)
    .set({ status: 'failed', lastError: 'connection_deleted', nextAttemptAt: null, updatedAt: ts })
    .where(
      and(
        eq(deliveries.workspaceId, t.workspaceId),
        eq(deliveries.connectionId, id),
        inArray(deliveries.status, ['pending', 'scheduled']),
      ),
    );
  await writeAudit(t, {
    action: 'connection.deleted',
    actor,
    targetType: 'connection',
    targetId: id,
    data: { platform: row.platform },
  });
}
