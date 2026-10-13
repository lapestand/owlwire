import { isUuid, newId } from '@owlwire/core';
import type { Severity } from '@owlwire/core/message';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { mapPgErrors, RepoInputError, RepoNotFoundError } from '../errors.js';
import { audiences, installations, rules, ruleTargets } from '../schema/index.js';
import type { TenantTx } from '../scope.js';
import { type AuditActor, writeAudit } from './audit.js';
import { assertIdShape, MALFORMED_ID, now, q } from './context.js';
import { lockVisibleDestinations } from './destinations.js';

export type RuleRow = typeof rules.$inferSelect;
export type RuleTargetInput = { destinationId: string } | { audienceId: string };
export interface RuleWithTargets extends RuleRow {
  targets: RuleTargetInput[];
}

export interface CreateRuleInput {
  installationId: string;
  name: string;
  types: string[];
  minSeverity?: Severity;
  filter?: unknown | null;
  enabled?: boolean;
  targets: RuleTargetInput[];
}

export type UpdateRulePatch = Partial<Omit<CreateRuleInput, 'installationId'>>;

const byId = (t: TenantTx, id: string) =>
  and(eq(rules.workspaceId, t.workspaceId), eq(rules.id, id));

interface SplitTargets {
  destinationIds: string[];
  audienceIds: string[];
}

/** Girdiyi tekilleştirir; tam olarak bir kimlik alanı taşımayan hedef RepoInputError. */
function splitTargets(targets: readonly RuleTargetInput[]): SplitTargets {
  const destinationIds = new Set<string>();
  const audienceIds = new Set<string>();
  for (const target of targets) {
    const dest = 'destinationId' in target ? target.destinationId : undefined;
    const aud = 'audienceId' in target ? target.audienceId : undefined;
    if (typeof dest === 'string' && aud === undefined) destinationIds.add(dest);
    else if (typeof aud === 'string' && dest === undefined) audienceIds.add(aud);
    else throw new RepoInputError('rule target', 'exactly one of destinationId or audienceId');
  }
  return { destinationIds: [...destinationIds], audienceIds: [...audienceIds] };
}

/**
 * Hedeflerin bu workspace'te görünür olduğunu kanıtlar (FK denetimi RLS'i yok sayar, yalnız FK yabancı kimliği
 * yakalamaz). Hedefler `lockVisibleDestinations` ile doğrulanır: yumuşak silinmiş ya da bağlantısı silinmiş hedef
 * RepoNotFoundError; bağlantı `FOR SHARE` kilidi, eşzamanlı `deleteConnection`'ın bu transaction'ın yazdığı kural
 * hedeflerini de silmesini sağlar. Alıcı listesi silmeye karşı FK (`ON DELETE NO ACTION`) korur.
 */
async function assertTargets(t: TenantTx, split: SplitTargets): Promise<void> {
  await lockVisibleDestinations(t, split.destinationIds);
  if (split.audienceIds.length === 0) return;
  if (!split.audienceIds.every(isUuid)) throw new RepoNotFoundError('audience', MALFORMED_ID);
  const own = await q(t)
    .select({ id: audiences.id })
    .from(audiences)
    .where(and(eq(audiences.workspaceId, t.workspaceId), inArray(audiences.id, split.audienceIds)));
  const seen = new Set(own.map((r) => r.id));
  const missing = split.audienceIds.find((id) => !seen.has(id));
  if (missing !== undefined) throw new RepoNotFoundError('audience', missing);
}

async function insertTargets(t: TenantTx, ruleId: string, split: SplitTargets): Promise<void> {
  const values = [
    ...split.destinationIds.map((destinationId) => ({ destinationId, audienceId: null })),
    ...split.audienceIds.map((audienceId) => ({ destinationId: null, audienceId })),
  ].map((v) => ({ id: newId(), workspaceId: t.workspaceId, ruleId, ...v }));
  if (values.length === 0) return;
  await mapPgErrors('rule target', ruleId, () => q(t).insert(ruleTargets).values(values));
}

async function attachTargets(t: TenantTx, rows: RuleRow[]): Promise<RuleWithTargets[]> {
  if (rows.length === 0) return [];
  const targetRows = await q(t)
    .select({
      ruleId: ruleTargets.ruleId,
      destinationId: ruleTargets.destinationId,
      audienceId: ruleTargets.audienceId,
    })
    .from(ruleTargets)
    .where(
      and(
        eq(ruleTargets.workspaceId, t.workspaceId),
        inArray(
          ruleTargets.ruleId,
          rows.map((r) => r.id),
        ),
      ),
    )
    .orderBy(asc(ruleTargets.id));
  const byRule = new Map<string, RuleTargetInput[]>();
  for (const tr of targetRows) {
    const target: RuleTargetInput | null = tr.destinationId
      ? { destinationId: tr.destinationId }
      : tr.audienceId
        ? { audienceId: tr.audienceId }
        : null;
    if (!target) continue;
    const list = byRule.get(tr.ruleId) ?? [];
    list.push(target);
    byRule.set(tr.ruleId, list);
  }
  return rows.map((r) => ({ ...r, targets: byRule.get(r.id) ?? [] }));
}

async function withTargets(t: TenantTx, row: RuleRow): Promise<RuleWithTargets> {
  const [loaded] = await attachTargets(t, [row]);
  if (!loaded) throw new Error('rule reload failed');
  return loaded;
}

/**
 * Kurulum bu workspace'te görünür ve `active` olmalıdır (iptal edilmiş ya da başka workspace'in kurulumu
 * RepoNotFoundError('installation')). Hedefler `assertTargets` ile kanıtlanır. Denetime yalnız kimlikler, tipler
 * ve hedef sayısı yazılır.
 */
export async function createRule(
  t: TenantTx,
  input: CreateRuleInput,
  actor: AuditActor,
): Promise<RuleWithTargets> {
  assertIdShape('installation', input.installationId);
  const inst = await q(t)
    .select({ id: installations.id })
    .from(installations)
    .where(
      and(
        eq(installations.workspaceId, t.workspaceId),
        eq(installations.id, input.installationId),
        eq(installations.status, 'active'),
      ),
    );
  if (!inst[0]) throw new RepoNotFoundError('installation', input.installationId);
  const split = splitTargets(input.targets);
  await assertTargets(t, split);
  const id = newId();
  const ts = now(t);
  const rows = await mapPgErrors('installation', input.installationId, () =>
    q(t)
      .insert(rules)
      .values({
        id,
        workspaceId: t.workspaceId,
        installationId: input.installationId,
        name: input.name,
        types: input.types,
        minSeverity: input.minSeverity ?? 'info',
        filter: input.filter ?? null,
        enabled: input.enabled ?? true,
        createdAt: ts,
        updatedAt: ts,
      })
      .returning(),
  );
  const row = rows[0];
  if (!row) throw new Error('rule insert returned no row');
  await insertTargets(t, id, split);
  await writeAudit(t, {
    action: 'rule.created',
    actor,
    targetType: 'rule',
    targetId: id,
    data: {
      installationId: input.installationId,
      types: input.types,
      targetCount: split.destinationIds.length + split.audienceIds.length,
    },
  });
  return withTargets(t, row);
}

/**
 * `targets` verilirse hedef kümesi atomik olarak değiştirilir. Yeni hedefler kural satırı güncellenmeden ve eski
 * hedefler silinmeden ÖNCE doğrulanıp kilitlenir: geçersiz hedef hiçbir yazım yapılmadan RepoNotFoundError /
 * RepoInputError verir (hatayı yakalayıp commit eden çağıran yarım bir güncelleme kalıcılaştıramaz). `deleteConnection`
 * önce bağlantıyı, sonra kural hedeflerini kilitler ve kurallar satırını hiç kilitlemez; bağlantı -> kural ->
 * kural hedefi sırası döngü oluşturmaz. Kurulum değiştirilemediği için yeniden denetlenmez.
 */
export async function updateRule(
  t: TenantTx,
  id: string,
  patch: UpdateRulePatch,
  actor: AuditActor,
): Promise<RuleWithTargets> {
  assertIdShape('rule', id);
  const split = patch.targets !== undefined ? splitTargets(patch.targets) : null;
  if (split) await assertTargets(t, split);
  const rows = await q(t)
    .update(rules)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.types !== undefined ? { types: patch.types } : {}),
      ...(patch.minSeverity !== undefined ? { minSeverity: patch.minSeverity } : {}),
      ...(patch.filter !== undefined ? { filter: patch.filter } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: now(t),
    })
    .where(byId(t, id))
    .returning();
  const row = rows[0];
  if (!row) throw new RepoNotFoundError('rule', id);
  if (split) {
    await q(t)
      .delete(ruleTargets)
      .where(and(eq(ruleTargets.workspaceId, t.workspaceId), eq(ruleTargets.ruleId, id)));
    await insertTargets(t, id, split);
  }
  await writeAudit(t, {
    action: 'rule.updated',
    actor,
    targetType: 'rule',
    targetId: id,
    data: {
      fields: Object.entries(patch)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
        .sort(),
    },
  });
  return withTargets(t, row);
}

/** Hedefler `ON DELETE CASCADE` ile birlikte silinir. */
export async function deleteRule(t: TenantTx, id: string, actor: AuditActor): Promise<void> {
  assertIdShape('rule', id);
  const rows = await q(t).delete(rules).where(byId(t, id)).returning({ id: rules.id });
  if (!rows[0]) throw new RepoNotFoundError('rule', id);
  await writeAudit(t, { action: 'rule.deleted', actor, targetType: 'rule', targetId: id });
}

export async function listRules(t: TenantTx): Promise<RuleWithTargets[]> {
  const rows = await q(t)
    .select()
    .from(rules)
    .where(eq(rules.workspaceId, t.workspaceId))
    .orderBy(asc(rules.createdAt), asc(rules.id));
  return attachTargets(t, rows);
}

/** Yalnız `enabled` kurallar; başka workspace'in kurulum kimliği boş dizi döner. */
export async function listRulesForInstallation(
  t: TenantTx,
  installationId: string,
): Promise<RuleWithTargets[]> {
  if (!isUuid(installationId)) return [];
  const rows = await q(t)
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.workspaceId, t.workspaceId),
        eq(rules.installationId, installationId),
        eq(rules.enabled, true),
      ),
    )
    .orderBy(asc(rules.createdAt), asc(rules.id));
  return attachTargets(t, rows);
}
