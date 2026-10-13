import { newId } from '@owlwire/core';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from './__test__/env.js';
import { type SeededTenant, seedTenant } from './__test__/seed.js';
import { pgErrorOf, RepoInputError, RepoNotFoundError } from './errors.js';
import { SYSTEM_ACTOR } from './repos/audit.js';
import { q } from './repos/context.js';
import * as repos from './repos/index.js';
import { type TenantTx, tenantScope, withTenant } from './scope.js';

type Attack = (t: TenantTx, victim: SeededTenant, attacker: SeededTenant) => Promise<unknown>;
type Case = { expect: 'no_victim_data' | 'not_found'; run: Attack } | { exempt: string };

/** Runs in the attacker's scope; the result must not carry any victim marker. */
const read = (run: Attack): Case => ({ expect: 'no_victim_data', run });
/** Runs in the attacker's scope against a victim id; must reject with RepoNotFoundError. */
const denied = (run: Attack): Case => ({ expect: 'not_found', run });
/** No cross-tenant attack is expressible; the reason must say concretely why. */
const exempt = (reason: string): Case => ({ exempt: reason });

// R121: repos/index.ts'e fonksiyon ekleyen her görev, AYNI görevde buraya gerçek bir read()/denied() vakası
// (ya da somut gerekçeli exempt()) ekler. Eksik/fazla girdi 'registry' testini kırar; testi gevşetmek yasaktır.
const CASES: Record<string, Case> = {
  // apps
  createApp: exempt('owner_workspace_id is always t.workspaceId; no input names another workspace'),
  getApp: read((t, v) => repos.getApp(t, v.appId)),
  listOwnApps: read((t) => repos.listOwnApps(t)),
  // audiences
  createAudience: exempt('workspace_id is always t.workspaceId; input is only a name'),
  deleteAudience: denied((t, v) => repos.deleteAudience(t, v.audienceId, SYSTEM_ACTOR)),
  expandAudiences: read((t, v) => repos.expandAudiences(t, [v.audienceId])),
  listAudienceMembers: denied((t, v) => repos.listAudienceMembers(t, v.audienceId)),
  listAudiences: read((t) => repos.listAudiences(t)),
  setAudienceMembers: denied((t, v, a) =>
    repos.setAudienceMembers(t, a.audienceId, [v.destinationId], SYSTEM_ACTOR),
  ),
  // audit
  AuditDataError: exempt('error class; constructing it touches no table'),
  assertAuditDataSafe: exempt('pure validation of an in-memory value; touches no table'),
  listAuditLog: read((t) => repos.listAuditLog(t, { limit: 200 })),
  writeAudit: exempt(
    'the TenantTx overload always writes workspace_id = t.workspaceId (audit.int.test.ts); the entry has no workspace field',
  ),
  // connections
  createConnection: exempt('workspace_id is always t.workspaceId; input references no other row'),
  deleteConnection: denied((t, v) => repos.deleteConnection(t, v.connectionId, SYSTEM_ACTOR)),
  getConnection: read((t, v) => repos.getConnection(t, v.connectionId)),
  listConnections: read((t) => repos.listConnections(t)),
  readConnectionConfig: denied((t, v) =>
    repos.readConnectionConfig(t, v.connectionId, { purpose: 'send' }),
  ),
  updateConnectionConfig: denied((t, v) =>
    repos.updateConnectionConfig(t, v.connectionId, { botToken: 'evil' }, SYSTEM_ACTOR),
  ),
  updateConnectionStatus: denied((t, v) =>
    repos.updateConnectionStatus(t, v.connectionId, 'paused', 'evil'),
  ),
  // deliveries
  createDeliveries: denied((t, v, a) =>
    repos.createDeliveries(t, a.eventId, [
      { destinationId: v.destinationId, connectionId: v.connectionId },
    ]),
  ),
  getDelivery: read((t, v) => repos.getDelivery(t, v.deliveryId)),
  listDeliveries: read((t) => repos.listDeliveries(t, { limit: 200 })),
  loadDeliveryContext: read((t, v) => repos.loadDeliveryContext(t, v.deliveryId)),
  updateDelivery: denied((t, v) => repos.updateDelivery(t, v.deliveryId, { status: 'failed' })),
  // destinations
  createDestination: denied((t, v) =>
    repos.createDestination(t, {
      connectionId: v.connectionId,
      kind: 'group',
      externalId: 'evil',
      name: 'evil',
    }),
  ),
  getDestination: read((t, v) => repos.getDestination(t, v.destinationId)),
  getDestinationsByIds: read((t, v) => repos.getDestinationsByIds(t, [v.destinationId])),
  listDestinations: read((t, v) => repos.listDestinations(t, { connectionId: v.connectionId })),
  updateDestinationStatus: denied((t, v) =>
    repos.updateDestinationStatus(t, v.destinationId, 'broken', 'evil'),
  ),
  // events
  getEvent: read((t, v) => repos.getEvent(t, v.eventId)),
  insertEvent: denied((t, v) =>
    repos.insertEvent(t, {
      installationId: v.installationId,
      idempotencyKey: 'evil',
      type: 'generic',
      severity: 'info',
      message: { type: 'generic', severity: 'info', body: 'evil' },
    }),
  ),
  markEventRouted: denied((t, v) => repos.markEventRouted(t, v.eventId)),
  // installations
  createInstallation: denied((t, v) =>
    repos.createInstallation(
      t,
      { appId: v.appId, tokenHash: 'evil-hash', tokenPrefix: 'ow_inst_evil' },
      SYSTEM_ACTOR,
    ),
  ),
  getInstallation: read((t, v) => repos.getInstallation(t, v.installationId)),
  listInstallations: read((t) => repos.listInstallations(t)),
  revokeInstallation: denied((t, v) => repos.revokeInstallation(t, v.installationId, SYSTEM_ACTOR)),
  // jobs
  connectionQueue: exempt('pure string builder for a queue name; touches no table'),
  digestJobKey: exempt('pure string builder for a job key; touches no table'),
  enqueueJob: exempt(
    'writes only graphile_worker.jobs, never a tenant table; workers resolve payload ids through tenant-scoped repos',
  ),
  healthJobKey: exempt('pure string builder for a job key; touches no table'),
  routeQueue: exempt('pure string builder for a queue name; touches no table'),
  sendJobKey: exempt('pure string builder for a job key; touches no table'),
  // rules
  createRule: denied((t, v, a) =>
    repos.createRule(
      t,
      {
        installationId: a.installationId,
        name: 'evil',
        types: ['*'],
        targets: [{ destinationId: v.destinationId }],
      },
      SYSTEM_ACTOR,
    ),
  ),
  deleteRule: denied((t, v) => repos.deleteRule(t, v.ruleId, SYSTEM_ACTOR)),
  listRules: read((t) => repos.listRules(t)),
  listRulesForInstallation: read((t, v) => repos.listRulesForInstallation(t, v.installationId)),
  updateRule: denied((t, v) => repos.updateRule(t, v.ruleId, { enabled: false }, SYSTEM_ACTOR)),
  // workspaces
  createWorkspace: exempt(
    'the new row id is always t.workspaceId; another workspace cannot be named or overwritten',
  ),
  getWorkspace: read((t) => repos.getWorkspace(t)),
};

/** Every table holding workspace-owned rows (keyed by workspace_id). apps and workspaces are snapshotted separately. */
const VICTIM_TABLES = [
  'connections',
  'destinations',
  'installations',
  'rules',
  'rule_targets',
  'events',
  'deliveries',
  'digests',
  'connection_counters',
  'workspace_keys',
  'audiences',
  'audience_members',
  'audit_log',
] as const;

/** Names missing from the registry and registry entries with no matching export. */
function registryDiff(
  exported: readonly string[],
  registered: readonly string[],
): { missing: string[]; extra: string[] } {
  return {
    missing: exported.filter((name) => !registered.includes(name)).sort(),
    extra: registered.filter((name) => !exported.includes(name)).sort(),
  };
}

const exportedFunctions = (mod: Record<string, unknown>): string[] =>
  Object.entries(mod)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name);

/** Thrown to roll back the control transaction. */
class RollbackControl extends Error {}

let env: DbTestEnv;
let victim: SeededTenant;
let attacker: SeededTenant;
let before: Record<string, string>;

/** Digest of every row the workspace owns, read with the OWNER pool (RLS does not hide anything). */
async function snapshot(ws: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of VICTIM_TABLES) {
    const { rows } = await env.owner.query<{ h: string; n: string }>(
      `select md5(coalesce(string_agg(row_to_json(x)::text, ',' order by row_to_json(x)::text), '')) as h,
              count(*) as n
         from ${table} x where workspace_id = $1`,
      [ws],
    );
    out[table] = `${rows[0]?.n}:${rows[0]?.h}`;
  }
  const w = await env.owner.query<{ h: string }>(
    'select md5(row_to_json(w)::text) as h from workspaces w where id = $1',
    [ws],
  );
  out.workspaces = w.rows[0]?.h ?? '';
  const apps = await env.owner.query<{ h: string }>(
    "select md5(coalesce(string_agg(row_to_json(a)::text, ',' order by a.id), '')) as h from apps a where owner_workspace_id = $1",
    [ws],
  );
  out.apps = apps.rows[0]?.h ?? '';
  return out;
}

/** All rows the workspace owns as JSON text (OWNER pool), for checking that no victim id leaked into them. */
async function ownedRowsText(ws: string): Promise<string> {
  const parts: string[] = [];
  for (const table of VICTIM_TABLES) {
    const { rows } = await env.owner.query<{ j: string | null }>(
      `select string_agg(row_to_json(x)::text, ',') as j from ${table} x where workspace_id = $1`,
      [ws],
    );
    parts.push(rows[0]?.j ?? '');
  }
  const apps = await env.owner.query<{ j: string | null }>(
    "select string_agg(row_to_json(a)::text, ',') as j from apps a where owner_workspace_id = $1",
    [ws],
  );
  parts.push(apps.rows[0]?.j ?? '');
  return parts.join('\n');
}

function victimMarkers(v: SeededTenant): string[] {
  return [
    v.workspaceId,
    v.connectionId,
    v.destinationId,
    v.audienceId,
    v.appId,
    v.installationId,
    v.ruleId,
    v.eventId,
    v.deliveryId,
    v.secret,
  ];
}

const asAttacker = <T>(fn: (t: TenantTx) => Promise<T>): Promise<T> =>
  withTenant(env.db, tenantScope(attacker.workspaceId), fn);

/** Runs a raw insert as the app role inside the attacker's tenant scope and returns the pg error it raised. */
async function rawInsertError(statement: ReturnType<typeof sql>): Promise<{
  code: string;
  constraint?: string;
} | null> {
  try {
    await asAttacker((t) => q(t).execute(statement));
  } catch (err) {
    return pgErrorOf(err);
  }
  return null;
}

beforeAll(async () => {
  env = await setupDbTestEnv();
  victim = await seedTenant(env.db, 'victim');
  attacker = await seedTenant(env.db, 'attacker');
  before = await snapshot(victim.workspaceId);
}, 180_000);

afterAll(async () => {
  await env?.stop();
});

describe('registry', () => {
  it('has a case for every function exported by repos/index.ts and nothing else', () => {
    const diff = registryDiff(exportedFunctions(repos), Object.keys(CASES));
    expect(diff).toEqual({ missing: [], extra: [] });
  });

  it('is red when an export has no case or a case has no export', () => {
    const registered = Object.keys(CASES);
    const withProbe = { ...repos, probeOnly: async () => null };
    expect(registryDiff(exportedFunctions(withProbe), registered)).toEqual({
      missing: ['probeOnly'],
      extra: [],
    });
    expect(registryDiff(exportedFunctions(repos), [...registered, 'staleEntry'])).toEqual({
      missing: [],
      extra: ['staleEntry'],
    });
  });

  it('gives every exemption a concrete reason', () => {
    for (const [name, c] of Object.entries(CASES)) {
      if ('exempt' in c) expect(c.exempt.length, name).toBeGreaterThan(20);
    }
  });
});

const attackCases = Object.entries(CASES).filter(
  (entry): entry is [string, Extract<Case, { run: Attack }>] => 'run' in entry[1],
);

describe.each(attackCases)('%s from another workspace', (_name, c) => {
  it(c.expect === 'not_found' ? 'is rejected as not found' : 'returns no victim data', async () => {
    const attempt = asAttacker((t) => c.run(t, victim, attacker));
    if (c.expect === 'not_found') {
      await expect(attempt).rejects.toBeInstanceOf(RepoNotFoundError);
      return;
    }
    const result = await attempt;
    const serialized =
      JSON.stringify(result, (_k, value) =>
        value instanceof Map ? [...value.entries()] : value,
      ) ?? 'null';
    for (const marker of victimMarkers(victim)) expect(serialized).not.toContain(marker);
  });
});

describe('additional attacks with victim ids', () => {
  it('rejects adding the attacker destination to the victim audience', async () => {
    await expect(
      asAttacker((t) =>
        repos.setAudienceMembers(t, victim.audienceId, [attacker.destinationId], SYSTEM_ACTOR),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('rejects a rule targeting the victim audience', async () => {
    await expect(
      asAttacker((t) =>
        repos.createRule(
          t,
          {
            installationId: attacker.installationId,
            name: 'evil',
            types: ['*'],
            targets: [{ audienceId: victim.audienceId }],
          },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('rejects a rule on the victim installation', async () => {
    await expect(
      asAttacker((t) =>
        repos.createRule(
          t,
          { installationId: victim.installationId, name: 'evil', types: ['*'], targets: [] },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('rejects retargeting the attacker rule at victim destinations and audiences', async () => {
    await expect(
      asAttacker((t) =>
        repos.updateRule(
          t,
          attacker.ruleId,
          { targets: [{ destinationId: victim.destinationId }] },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
    await expect(
      asAttacker((t) =>
        repos.updateRule(
          t,
          attacker.ruleId,
          { targets: [{ audienceId: victim.audienceId }] },
          SYSTEM_ACTOR,
        ),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('rejects deliveries for the victim event', async () => {
    await expect(
      asAttacker((t) =>
        repos.createDeliveries(t, victim.eventId, [
          { destinationId: attacker.destinationId, connectionId: attacker.connectionId },
        ]),
      ),
    ).rejects.toBeInstanceOf(RepoNotFoundError);
  });

  it('rejects an own delivery routed to the victim connection queue', async () => {
    await expect(
      asAttacker((t) =>
        repos.createDeliveries(t, attacker.eventId, [
          { destinationId: attacker.destinationId, connectionId: victim.connectionId },
        ]),
      ),
    ).rejects.toBeInstanceOf(RepoInputError);
  });
});

describe('composite foreign keys reject victim ids under the app role', () => {
  it('rule_targets_rule_ws_fk rejects an own row pointing at the victim rule', async () => {
    const err = await rawInsertError(
      sql`insert into rule_targets (id, workspace_id, rule_id, destination_id)
          values (${newId()}, ${attacker.workspaceId}, ${victim.ruleId}, ${attacker.destinationId})`,
    );
    expect(err).toEqual({ code: '23503', constraint: 'rule_targets_rule_ws_fk' });
  });

  it('audience_members_audience_ws_fk rejects an own row pointing at the victim audience', async () => {
    const err = await rawInsertError(
      sql`insert into audience_members (audience_id, destination_id, workspace_id)
          values (${victim.audienceId}, ${attacker.destinationId}, ${attacker.workspaceId})`,
    );
    expect(err).toEqual({ code: '23503', constraint: 'audience_members_audience_ws_fk' });
  });

  it('digests_destination_ws_fk rejects an own row pointing at the victim destination', async () => {
    const err = await rawInsertError(
      sql`insert into digests (id, workspace_id, destination_id, connection_id, window_start, window_end)
          values (${newId()}, ${attacker.workspaceId}, ${victim.destinationId}, ${attacker.connectionId},
                  now(), now() + interval '1 hour')`,
    );
    expect(err).toEqual({ code: '23503', constraint: 'digests_destination_ws_fk' });
  });

  it('accepts the same raw inserts with own ids (the rejections above are the composite FKs)', async () => {
    await asAttacker(async (t) => {
      await q(t).execute(
        sql`insert into rule_targets (id, workspace_id, rule_id, destination_id)
            values (${newId()}, ${attacker.workspaceId}, ${attacker.ruleId}, ${attacker.destinationId})`,
      );
      const aud = await repos.createAudience(t, { name: 'fk-control' }, SYSTEM_ACTOR);
      await q(t).execute(
        sql`insert into audience_members (audience_id, destination_id, workspace_id)
            values (${aud.id}, ${attacker.destinationId}, ${attacker.workspaceId})`,
      );
      await q(t).execute(
        sql`insert into digests (id, workspace_id, destination_id, connection_id, window_start, window_end)
            values (${newId()}, ${attacker.workspaceId}, ${attacker.destinationId}, ${attacker.connectionId},
                    now(), now() + interval '1 hour')`,
      );
      // Roll back the control rows so they cannot affect later checks.
      throw new RollbackControl();
    }).catch((err: unknown) => {
      if (!(err instanceof RollbackControl)) throw err;
    });
  });
});

describe('after all attacks', () => {
  it('leaves the victim workspace byte-for-byte unchanged', async () => {
    expect(await snapshot(victim.workspaceId)).toEqual(before);
  });

  it('left no victim id in any row the attacker owns', async () => {
    const text = await ownedRowsText(attacker.workspaceId);
    for (const marker of victimMarkers(victim)) expect(text).not.toContain(marker);
  });
});
