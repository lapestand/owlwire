import { randomUUID } from 'node:crypto';
import { newId } from '@owlwire/core';
import { type SQL, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type DbTestEnv, setupDbTestEnv } from './__test__/env.js';
import { type SeededTenant, seedTenant } from './__test__/seed.js';
import { pgErrorOf, RepoInputError, RepoNotFoundError } from './errors.js';
import { type OwlwireDb, openDatabase } from './handle.js';
import { SYSTEM_ACTOR } from './repos/audit.js';
import { q } from './repos/context.js';
import * as repos from './repos/index.js';
import { type TenantTx, tenantScope, withTenant } from './scope.js';

type Attack = (t: TenantTx, victim: SeededTenant, attacker: SeededTenant) => Promise<unknown>;
type Case =
  | { kind: 'read'; run: Attack }
  | { kind: 'denied'; entity: string; id: (v: SeededTenant) => string; run: Attack }
  | { kind: 'contained'; run: Attack }
  | { kind: 'exempt'; reason: string };

/**
 * Attacker scope, victim ids: the result must carry no victim marker. Positive control: the same call in the
 * victim's own scope must return victim data (so the case really points at victim rows).
 */
const read = (run: Attack): Case => ({ kind: 'read', run });
/** Attacker scope, victim id: must reject with RepoNotFoundError naming exactly this entity and victim id. */
const denied = (entity: string, id: (v: SeededTenant) => string, run: Attack): Case => ({
  kind: 'denied',
  entity,
  id,
  run,
});
/**
 * The call may succeed, but only inside the attacker's own namespace: the victim snapshot must not change.
 * Positive control: the same call by a third tenant against its own ids does change that tenant's snapshot.
 */
const contained = (run: Attack): Case => ({ kind: 'contained', run });
/** No cross-tenant attack is expressible; see EXEMPT_JUSTIFICATIONS for the accepted reasons. */
const exempt = (reason: string): Case => ({ kind: 'exempt', reason });

// R121: repos/index.ts'e fonksiyon ekleyen her görev, AYNI görevde buraya gerçek bir read()/denied()/contained()
// vakası (ya da somut gerekçeli exempt()) ekler. Eksik/fazla girdi 'registry' testini kırar; testi gevşetmek yasaktır.
const CASES: Record<string, Case> = {
  // apps
  createApp: exempt('owner_workspace_id is always t.workspaceId; no input names another workspace'),
  getApp: read((t, v) => repos.getApp(t, v.appId)),
  listOwnApps: read((t) => repos.listOwnApps(t)),
  // audiences
  createAudience: exempt('workspace_id is always t.workspaceId; the input is only a name'),
  deleteAudience: denied(
    'audience',
    (v) => v.audienceId,
    (t, v) => repos.deleteAudience(t, v.audienceId, SYSTEM_ACTOR),
  ),
  expandAudiences: read((t, v) => repos.expandAudiences(t, [v.audienceId])),
  listAudienceMembers: denied(
    'audience',
    (v) => v.audienceId,
    (t, v) => repos.listAudienceMembers(t, v.audienceId),
  ),
  listAudiences: read((t) => repos.listAudiences(t)),
  setAudienceMembers: denied(
    'destination',
    (v) => v.destinationId,
    (t, v, a) => repos.setAudienceMembers(t, a.audienceId, [v.destinationId], SYSTEM_ACTOR),
  ),
  // audit
  AuditDataError: exempt('error class; constructing it touches no table'),
  assertAuditDataSafe: exempt('validates an in-memory value only and touches no table'),
  listAuditLog: read((t) => repos.listAuditLog(t, { limit: 200 })),
  writeAudit: exempt(
    'the TenantTx overload always writes workspace_id = t.workspaceId (audit.int.test.ts); the entry has no workspace field and audit_log has no FK on target ids',
  ),
  // connections
  createConnection: exempt(
    'workspace_id is always t.workspaceId; the input references no other row',
  ),
  deleteConnection: denied(
    'connection',
    (v) => v.connectionId,
    (t, v) => repos.deleteConnection(t, v.connectionId, SYSTEM_ACTOR),
  ),
  getConnection: read((t, v) => repos.getConnection(t, v.connectionId)),
  listConnections: read((t) => repos.listConnections(t)),
  readConnectionConfig: denied(
    'connection',
    (v) => v.connectionId,
    (t, v) => repos.readConnectionConfig(t, v.connectionId, { purpose: 'send' }),
  ),
  updateConnectionConfig: denied(
    'connection',
    (v) => v.connectionId,
    (t, v) => repos.updateConnectionConfig(t, v.connectionId, { botToken: 'evil' }, SYSTEM_ACTOR),
  ),
  updateConnectionStatus: denied(
    'connection',
    (v) => v.connectionId,
    (t, v) => repos.updateConnectionStatus(t, v.connectionId, 'paused', 'evil'),
  ),
  // deliveries
  createDeliveries: denied(
    'destination',
    (v) => v.destinationId,
    (t, v, a) =>
      repos.createDeliveries(t, a.eventId, [
        { destinationId: v.destinationId, connectionId: v.connectionId },
      ]),
  ),
  getDelivery: read((t, v) => repos.getDelivery(t, v.deliveryId)),
  listDeliveries: read((t) => repos.listDeliveries(t, { limit: 200 })),
  loadDeliveryContext: read((t, v) => repos.loadDeliveryContext(t, v.deliveryId)),
  updateDelivery: denied(
    'delivery',
    (v) => v.deliveryId,
    (t, v) => repos.updateDelivery(t, v.deliveryId, { status: 'failed' }),
  ),
  // destinations
  createDestination: denied(
    'connection',
    (v) => v.connectionId,
    (t, v) =>
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
  updateDestinationStatus: denied(
    'destination',
    (v) => v.destinationId,
    (t, v) => repos.updateDestinationStatus(t, v.destinationId, 'broken', 'evil'),
  ),
  // events
  getEvent: read((t, v) => repos.getEvent(t, v.eventId)),
  insertEvent: denied(
    'installation',
    (v) => v.installationId,
    (t, v) =>
      repos.insertEvent(t, {
        installationId: v.installationId,
        idempotencyKey: 'evil',
        type: 'generic',
        severity: 'info',
        message: { type: 'generic', severity: 'info', body: 'evil' },
      }),
  ),
  markEventRouted: denied(
    'event',
    (v) => v.eventId,
    (t, v) => repos.markEventRouted(t, v.eventId),
  ),
  // installations
  createInstallation: denied(
    'app',
    (v) => v.appId,
    (t, v) =>
      repos.createInstallation(
        t,
        { appId: v.appId, tokenHash: `evil-${randomUUID()}`, tokenPrefix: 'ow_inst_evil' },
        SYSTEM_ACTOR,
      ),
  ),
  getInstallation: read((t, v) => repos.getInstallation(t, v.installationId)),
  listInstallations: read((t) => repos.listInstallations(t)),
  revokeInstallation: denied(
    'installation',
    (v) => v.installationId,
    (t, v) => repos.revokeInstallation(t, v.installationId, SYSTEM_ACTOR),
  ),
  // jobs
  connectionQueue: exempt('pure string builder for a queue name; touches no table'),
  digestJobKey: exempt('pure string builder for a job key; touches no table'),
  enqueueJob: contained((t, v) =>
    repos.enqueueJob(
      t,
      'send_delivery',
      { deliveryId: v.deliveryId },
      {
        queueName: repos.connectionQueue(v.connectionId),
        jobKey: repos.sendJobKey(v.deliveryId),
        jobKeyMode: 'replace',
        runAt: new Date('2099-01-01T00:00:00.000Z'),
      },
    ),
  ),
  healthJobKey: exempt('pure string builder for a job key; touches no table'),
  routeQueue: exempt('pure string builder for a queue name; touches no table'),
  sendJobKey: exempt('pure string builder for a job key; touches no table'),
  tenantJobName: exempt('pure string builder for a namespaced job name; touches no table'),
  // rules
  createRule: denied(
    'destination',
    (v) => v.destinationId,
    (t, v, a) =>
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
  deleteRule: denied(
    'rule',
    (v) => v.ruleId,
    (t, v) => repos.deleteRule(t, v.ruleId, SYSTEM_ACTOR),
  ),
  listRules: read((t) => repos.listRules(t)),
  listRulesForInstallation: read((t, v) => repos.listRulesForInstallation(t, v.installationId)),
  updateRule: denied(
    'rule',
    (v) => v.ruleId,
    (t, v) => repos.updateRule(t, v.ruleId, { enabled: false }, SYSTEM_ACTOR),
  ),
  // workspaces
  createWorkspace: exempt(
    'the new row id is always t.workspaceId; another workspace cannot be named or overwritten',
  ),
  getWorkspace: read((t) => repos.getWorkspace(t)),
};

/** An exemption must name one of these concrete mechanisms; vague words are rejected outright. */
const EXEMPT_JUSTIFICATIONS = ['t.workspaceId', 'touches no table'] as const;
const VAGUE_WORDS =
  /\b(not needed|unneeded|unnecessary|n\/a|todo|later|trivial|obviously|fine|safe|ok|gerekmez|sonra)\b/i;

type Expected =
  | { name: 'RepoNotFoundError'; entity: string; id: string }
  | { name: 'RepoInputError' };

/** Attacks beyond one-per-function: other victim-id positions of the same functions. */
const EXTRA_ATTACKS: Array<[string, Attack, (v: SeededTenant) => Expected]> = [
  [
    'setAudienceMembers: attacker destination into the victim audience',
    (t, v, a) => repos.setAudienceMembers(t, v.audienceId, [a.destinationId], SYSTEM_ACTOR),
    (v) => ({ name: 'RepoNotFoundError', entity: 'audience', id: v.audienceId }),
  ],
  [
    'createRule: target the victim audience',
    (t, v, a) =>
      repos.createRule(
        t,
        {
          installationId: a.installationId,
          name: 'evil',
          types: ['*'],
          targets: [{ audienceId: v.audienceId }],
        },
        SYSTEM_ACTOR,
      ),
    (v) => ({ name: 'RepoNotFoundError', entity: 'audience', id: v.audienceId }),
  ],
  [
    'createRule: on the victim installation',
    (t, v) =>
      repos.createRule(
        t,
        { installationId: v.installationId, name: 'evil', types: ['*'], targets: [] },
        SYSTEM_ACTOR,
      ),
    (v) => ({ name: 'RepoNotFoundError', entity: 'installation', id: v.installationId }),
  ],
  [
    'updateRule: retarget the attacker rule at the victim destination',
    (t, v, a) =>
      repos.updateRule(
        t,
        a.ruleId,
        { targets: [{ destinationId: v.destinationId }] },
        SYSTEM_ACTOR,
      ),
    (v) => ({ name: 'RepoNotFoundError', entity: 'destination', id: v.destinationId }),
  ],
  [
    'updateRule: retarget the attacker rule at the victim audience',
    (t, v, a) =>
      repos.updateRule(t, a.ruleId, { targets: [{ audienceId: v.audienceId }] }, SYSTEM_ACTOR),
    (v) => ({ name: 'RepoNotFoundError', entity: 'audience', id: v.audienceId }),
  ],
  [
    'createDeliveries: for the victim event',
    (t, v, a) =>
      repos.createDeliveries(t, v.eventId, [
        { destinationId: a.destinationId, connectionId: a.connectionId },
      ]),
    (v) => ({ name: 'RepoNotFoundError', entity: 'event', id: v.eventId }),
  ],
  [
    'createDeliveries: own delivery into the victim connection queue',
    (t, v, a) =>
      repos.createDeliveries(t, a.eventId, [
        { destinationId: a.destinationId, connectionId: v.connectionId },
      ]),
    () => ({ name: 'RepoInputError' }),
  ],
  [
    'enqueueJob: payload forging the victim workspace',
    (t, v) =>
      repos.enqueueJob(t, 'send_delivery', { deliveryId: v.deliveryId, _ws: v.workspaceId }),
    () => ({ name: 'RepoInputError' }),
  ],
];

/** Every public table with a workspace_id column. Checked against the catalog below. */
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

/** Public tables without a workspace_id column, and how the snapshot covers them (or why it does not). */
const NON_WORKSPACE_TABLES: Record<string, string> = {
  workspaces: 'snapshotted by id',
  apps: 'snapshotted by owner_workspace_id',
  catalog_types: 'snapshotted through apps.owner_workspace_id',
  instance_settings: 'instance-level, system-only RLS; no tenant owns a row',
  rate_buckets: 'instance-level pacing state keyed by scope text; no tenant repository writes it',
};

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

/** Exported objects that carry functions (an `xRepo = { fn }` would escape the per-function registry). */
const exportedFunctionBags = (mod: Record<string, unknown>): string[] =>
  Object.entries(mod)
    .filter(
      ([, value]) =>
        value !== null &&
        typeof value === 'object' &&
        Object.values(value).some((inner) => typeof inner === 'function'),
    )
    .map(([name]) => name);

function exemptProblems(reason: string): string[] {
  const problems: string[] = [];
  if (reason.length < 30) problems.push('too short');
  if (VAGUE_WORDS.test(reason)) problems.push('vague wording');
  if (!EXEMPT_JUSTIFICATIONS.some((j) => reason.includes(j))) {
    problems.push(`names none of ${EXEMPT_JUSTIFICATIONS.join(', ')}`);
  }
  return problems;
}

/** Thrown to roll back a control transaction. */
class RollbackControl extends Error {}

let env: DbTestEnv;
let ownerDb: OwlwireDb;
let victim: SeededTenant;
let attacker: SeededTenant;
let control: SeededTenant;
let before: Record<string, string>;

const JOB_ROWS = `
  select j.*, p.payload
    from graphile_worker.jobs j
    join graphile_worker._private_jobs p on p.id = j.id
   where j.queue_name like $1 or j.key like $1 or p.payload->>'_ws' = $2
      or (p.payload->>'_ws' is null
          and (coalesce(j.queue_name, '') || ' ' || coalesce(j.key, '') || ' ' || p.payload::text) ~ $3)`;

/** Digest (count:md5) of everything the workspace owns, read with the OWNER pool (RLS hides nothing). */
async function snapshot(v: SeededTenant): Promise<Record<string, string>> {
  const ws = v.workspaceId;
  const ids = markers(v).filter((m) => m !== v.secret);
  const digest = async (from: string, values: unknown[]): Promise<string> => {
    const { rows } = await env.owner.query<{ h: string; n: string }>(
      `select md5(coalesce(string_agg(x::text, ',' order by x::text), '')) as h, count(*) as n
         from (select row_to_json(r) as x from (${from}) r) s`,
      values,
    );
    return `${rows[0]?.n}:${rows[0]?.h}`;
  };
  const out: Record<string, string> = {};
  for (const table of VICTIM_TABLES) {
    out[table] = await digest(`select * from ${table} where workspace_id = $1`, [ws]);
  }
  out.workspaces = await digest('select * from workspaces where id = $1', [ws]);
  out.apps = await digest('select * from apps where owner_workspace_id = $1', [ws]);
  out.catalog_types = await digest(
    'select c.* from catalog_types c join apps a on a.id = c.app_id where a.owner_workspace_id = $1',
    [ws],
  );
  // Namespaced jobs of the workspace, plus un-namespaced (system or legacy) jobs that mention one of its ids.
  out.jobs = await digest(JOB_ROWS, [`${repos.tenantJobName(ws, '')}%`, ws, ids.join('|')]);
  return out;
}

/** All table rows the workspace owns as JSON text (OWNER pool), for checking that no victim id leaked into them. */
async function ownedRowsText(ws: string): Promise<string> {
  const parts: string[] = [];
  const queries = [
    ...VICTIM_TABLES.map((table) => `select * from ${table} where workspace_id = $1`),
    'select * from apps where owner_workspace_id = $1',
    'select c.* from catalog_types c join apps a on a.id = c.app_id where a.owner_workspace_id = $1',
  ];
  for (const text of queries) {
    const { rows } = await env.owner.query<{ j: string | null }>(
      `select string_agg(row_to_json(r)::text, ',') as j from (${text}) r`,
      [ws],
    );
    parts.push(rows[0]?.j ?? '');
  }
  return parts.join('\n');
}

function markers(v: SeededTenant): string[] {
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
    v.digestId,
    v.secret,
  ];
}

const serialize = (value: unknown): string =>
  JSON.stringify(value, (_k, inner) => (inner instanceof Map ? [...inner.entries()] : inner)) ??
  'null';

const inScope = <T>(db: OwlwireDb, ws: string, fn: (t: TenantTx) => Promise<T>): Promise<T> =>
  withTenant(db, tenantScope(ws), fn);

beforeAll(async () => {
  env = await setupDbTestEnv();
  victim = await seedTenant(env.db, 'victim');
  attacker = await seedTenant(env.db, 'attacker');
  control = await seedTenant(env.db, 'control');
  // Owner role owns the tables and they are not FORCE RLS: on this handle only the repository filters isolate.
  ownerDb = openDatabase({ url: env.tdb.ownerUrl, keyring: env.keyring, clock: env.clock });
  before = await snapshot(victim);
}, 180_000);

afterAll(async () => {
  await ownerDb?.close();
  await env?.stop();
});

describe('registry', () => {
  it('has a case for every function exported by repos/index.ts and nothing else', () => {
    expect(registryDiff(exportedFunctions(repos), Object.keys(CASES))).toEqual({
      missing: [],
      extra: [],
    });
  });

  it('exports no object carrying functions', () => {
    expect(exportedFunctionBags(repos)).toEqual([]);
  });

  it('is red when an export has no case, a case has no export, or an object hides functions', () => {
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
    expect(exportedFunctionBags({ ...repos, probeRepo: { fn: () => null } })).toEqual([
      'probeRepo',
    ]);
  });

  it('gives every exemption a concrete reason', () => {
    for (const [name, c] of Object.entries(CASES)) {
      if (c.kind === 'exempt') expect(exemptProblems(c.reason), name).toEqual([]);
    }
    expect(exemptProblems('not needed')).not.toEqual([]);
    expect(exemptProblems('writes only graphile_worker.jobs, never a tenant table')).not.toEqual(
      [],
    );
  });
});

describe('schema coverage', () => {
  it('VICTIM_TABLES is exactly the set of public tables with a workspace_id column', async () => {
    const { rows } = await env.owner.query<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema = 'public' and column_name = 'workspace_id'",
    );
    expect(rows.map((r) => r.table_name).sort()).toEqual([...VICTIM_TABLES].sort());
  });

  it('every other public table is a documented exclusion', async () => {
    const { rows } = await env.owner.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'",
    );
    const others = rows
      .map((r) => r.table_name)
      .filter((name) => !(VICTIM_TABLES as readonly string[]).includes(name))
      .sort();
    expect(others).toEqual(Object.keys(NON_WORKSPACE_TABLES).sort());
  });

  it('the seeded victim owns a row in every snapshotted table and has queued jobs', () => {
    for (const [table, digest] of Object.entries(before)) {
      expect(digest.startsWith('0:'), table).toBe(false);
    }
  });
});

const attackCases = Object.entries(CASES).filter(
  (entry): entry is [string, Exclude<Case, { kind: 'exempt' }>] => entry[1].kind !== 'exempt',
);

const PASSES: Array<[string, () => OwlwireDb]> = [
  ['app role, RLS enforced', () => env.db],
  ['owner role, RLS bypassed (repository filters alone)', () => ownerDb],
];

describe.each(PASSES)('attacks as %s', (_pass, dbOf) => {
  describe.each(attackCases)('%s from another workspace', (_name, c) => {
    it(`is ${c.kind} and leaves the victim unchanged`, async () => {
      const attempt = inScope(dbOf(), attacker.workspaceId, (t) => c.run(t, victim, attacker));
      if (c.kind === 'denied') {
        const err = await attempt.then(
          () => null,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(RepoNotFoundError);
        expect(err).toMatchObject({ entity: c.entity, id: c.id(victim) });
      } else if (c.kind === 'read') {
        const text = serialize(await attempt);
        for (const marker of markers(victim)) expect(text).not.toContain(marker);
      } else {
        await attempt;
      }
      expect(await snapshot(victim)).toEqual(before);
    });

    if (c.kind === 'read') {
      it('positive control: returns victim data in the victim scope', async () => {
        const text = serialize(
          await inScope(dbOf(), victim.workspaceId, (t) => c.run(t, victim, attacker)),
        );
        expect(markers(victim).some((marker) => text.includes(marker))).toBe(true);
      });
    }

    if (c.kind === 'contained') {
      it('positive control: the same call on own ids changes the owner snapshot', async () => {
        const own = await snapshot(control);
        await inScope(dbOf(), control.workspaceId, (t) => c.run(t, control, control));
        expect(await snapshot(control)).not.toEqual(own);
      });
    }
  });

  describe.each(EXTRA_ATTACKS)('%s', (_name, run, expected) => {
    it('is rejected and leaves the victim unchanged', async () => {
      const err = await inScope(dbOf(), attacker.workspaceId, (t) => run(t, victim, attacker)).then(
        () => null,
        (e: unknown) => e,
      );
      const want = expected(victim);
      expect(err).toBeInstanceOf(
        want.name === 'RepoInputError' ? RepoInputError : RepoNotFoundError,
      );
      expect(err).toMatchObject(
        want.name === 'RepoInputError' ? {} : { entity: want.entity, id: want.id },
      );
      expect(await snapshot(victim)).toEqual(before);
    });
  });
});

/** Attacker-owned ids that are free of unique-key collisions (fresh event, empty audience, rule without targets). */
interface OwnIds {
  ws: string;
  connectionId: string;
  destinationId: string;
  audienceId: string;
  installationId: string;
  ruleId: string;
  eventId: string;
  digestId: string;
}

interface FkSpec {
  constraint: string;
  table: string;
  column: string;
  victimValue: (v: SeededTenant) => string;
  row: (o: OwnIds) => Record<string, unknown>;
}

const window = () => ({
  window_start: new Date('2026-10-12T09:00:00Z'),
  window_end: new Date('2026-10-12T10:00:00Z'),
});
const delivery = (o: OwnIds) => ({
  id: newId(),
  workspace_id: o.ws,
  event_id: o.eventId,
  destination_id: o.destinationId,
  connection_id: o.connectionId,
});

/** Every composite `*_ws_fk`; the list is checked against pg_constraint. */
const FK_SPECS: FkSpec[] = [
  {
    constraint: 'audience_members_audience_ws_fk',
    table: 'audience_members',
    column: 'audience_id',
    victimValue: (v) => v.audienceId,
    row: (o) => ({
      audience_id: o.audienceId,
      destination_id: o.destinationId,
      workspace_id: o.ws,
    }),
  },
  {
    constraint: 'audience_members_destination_ws_fk',
    table: 'audience_members',
    column: 'destination_id',
    victimValue: (v) => v.destinationId,
    row: (o) => ({
      audience_id: o.audienceId,
      destination_id: o.destinationId,
      workspace_id: o.ws,
    }),
  },
  {
    constraint: 'connection_counters_connection_ws_fk',
    table: 'connection_counters',
    column: 'connection_id',
    victimValue: (v) => v.connectionId,
    row: (o) => ({ connection_id: o.connectionId, workspace_id: o.ws, day: '2026-10-13' }),
  },
  {
    constraint: 'deliveries_connection_ws_fk',
    table: 'deliveries',
    column: 'connection_id',
    victimValue: (v) => v.connectionId,
    row: delivery,
  },
  {
    constraint: 'deliveries_destination_ws_fk',
    table: 'deliveries',
    column: 'destination_id',
    victimValue: (v) => v.destinationId,
    row: delivery,
  },
  {
    constraint: 'deliveries_digest_ws_fk',
    table: 'deliveries',
    column: 'digest_id',
    victimValue: (v) => v.digestId,
    row: (o) => ({ ...delivery(o), digest_id: o.digestId }),
  },
  {
    constraint: 'deliveries_event_ws_fk',
    table: 'deliveries',
    column: 'event_id',
    victimValue: (v) => v.eventId,
    row: delivery,
  },
  {
    constraint: 'destinations_connection_ws_fk',
    table: 'destinations',
    column: 'connection_id',
    victimValue: (v) => v.connectionId,
    row: (o) => ({
      id: newId(),
      workspace_id: o.ws,
      connection_id: o.connectionId,
      kind: 'group',
      external_id: `fk-${randomUUID()}`,
      name: 'fk',
    }),
  },
  {
    constraint: 'digests_connection_ws_fk',
    table: 'digests',
    column: 'connection_id',
    victimValue: (v) => v.connectionId,
    row: (o) => ({
      id: newId(),
      workspace_id: o.ws,
      destination_id: o.destinationId,
      connection_id: o.connectionId,
      ...window(),
    }),
  },
  {
    constraint: 'digests_destination_ws_fk',
    table: 'digests',
    column: 'destination_id',
    victimValue: (v) => v.destinationId,
    row: (o) => ({
      id: newId(),
      workspace_id: o.ws,
      destination_id: o.destinationId,
      connection_id: o.connectionId,
      ...window(),
    }),
  },
  {
    constraint: 'events_installation_ws_fk',
    table: 'events',
    column: 'installation_id',
    victimValue: (v) => v.installationId,
    row: (o) => ({
      id: newId(),
      workspace_id: o.ws,
      installation_id: o.installationId,
      idempotency_key: `fk-${randomUUID()}`,
      type: 'generic',
      severity: 'info',
      message: JSON.stringify({ type: 'generic', severity: 'info', body: 'fk' }),
    }),
  },
  {
    constraint: 'rule_targets_audience_ws_fk',
    table: 'rule_targets',
    column: 'audience_id',
    victimValue: (v) => v.audienceId,
    row: (o) => ({ id: newId(), workspace_id: o.ws, rule_id: o.ruleId, audience_id: o.audienceId }),
  },
  {
    constraint: 'rule_targets_destination_ws_fk',
    table: 'rule_targets',
    column: 'destination_id',
    victimValue: (v) => v.destinationId,
    row: (o) => ({
      id: newId(),
      workspace_id: o.ws,
      rule_id: o.ruleId,
      destination_id: o.destinationId,
    }),
  },
  {
    constraint: 'rule_targets_rule_ws_fk',
    table: 'rule_targets',
    column: 'rule_id',
    victimValue: (v) => v.ruleId,
    row: (o) => ({
      id: newId(),
      workspace_id: o.ws,
      rule_id: o.ruleId,
      destination_id: o.destinationId,
    }),
  },
  {
    constraint: 'rules_installation_ws_fk',
    table: 'rules',
    column: 'installation_id',
    victimValue: (v) => v.installationId,
    row: (o) => ({
      id: newId(),
      workspace_id: o.ws,
      installation_id: o.installationId,
      name: 'fk',
      types: '{*}',
    }),
  },
];

function insertSql(table: string, row: Record<string, unknown>): SQL {
  const cols = Object.keys(row);
  return sql`insert into ${sql.identifier(table)} (${sql.join(
    cols.map((c) => sql.identifier(c)),
    sql`, `,
  )}) values (${sql.join(
    cols.map((c) => sql`${row[c]}`),
    sql`, `,
  )})`;
}

/** Runs the insert as the app role in the attacker scope, always rolled back; returns the pg error or null. */
async function tryInsert(statement: SQL): Promise<{ code: string; constraint?: string } | null> {
  try {
    await inScope(env.db, attacker.workspaceId, async (t) => {
      await q(t).execute(statement);
      throw new RollbackControl();
    });
  } catch (err) {
    if (err instanceof RollbackControl) return null;
    return pgErrorOf(err);
  }
  return null;
}

describe('composite foreign keys reject victim ids under the app role', () => {
  let own: OwnIds;

  beforeAll(async () => {
    own = await inScope(env.db, attacker.workspaceId, async (t) => {
      const aud = await repos.createAudience(t, { name: 'fk-spare' }, SYSTEM_ACTOR);
      const rule = await repos.createRule(
        t,
        { installationId: attacker.installationId, name: 'fk-spare', types: ['*'], targets: [] },
        SYSTEM_ACTOR,
      );
      const ev = await repos.insertEvent(t, {
        installationId: attacker.installationId,
        idempotencyKey: 'fk-spare',
        type: 'generic',
        severity: 'info',
        message: { type: 'generic', severity: 'info', body: 'fk' },
      });
      return {
        ws: attacker.workspaceId,
        connectionId: attacker.connectionId,
        destinationId: attacker.destinationId,
        audienceId: aud.id,
        installationId: attacker.installationId,
        ruleId: rule.id,
        eventId: ev.eventId,
        digestId: attacker.digestId,
      };
    });
  });

  it('FK_SPECS lists exactly the *_ws_fk constraints of pg_constraint, on the right table and column', async () => {
    const { rows } = await env.owner.query<{ name: string; tbl: string; cols: string[] }>(
      `select c.conname as name, c.conrelid::regclass::text as tbl,
              array(select a.attname::text from unnest(c.conkey) k join pg_attribute a
                      on a.attrelid = c.conrelid and a.attnum = k) as cols
         from pg_constraint c where c.contype = 'f' and c.conname like '%\\_ws\\_fk'`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(FK_SPECS.map((s) => s.constraint).sort());
    for (const spec of FK_SPECS) {
      const row = rows.find((r) => r.name === spec.constraint);
      expect(row?.tbl, spec.constraint).toBe(spec.table);
      expect(row?.cols.slice().sort(), spec.constraint).toEqual(
        [spec.column, 'workspace_id'].sort(),
      );
    }
  });

  it.each(FK_SPECS)('$constraint rejects an own row pointing at a victim id', async (spec) => {
    const ownRow = spec.row(own);
    expect(await tryInsert(insertSql(spec.table, ownRow)), 'control with own ids').toBeNull();
    const attack = { ...spec.row(own), [spec.column]: spec.victimValue(victim) };
    expect(await tryInsert(insertSql(spec.table, attack))).toEqual({
      code: '23503',
      constraint: spec.constraint,
    });
  });
});

describe('after all attacks', () => {
  it('leaves the victim workspace byte-for-byte unchanged', async () => {
    expect(await snapshot(victim)).toEqual(before);
  });

  it('left no victim id in any row the attacker owns', async () => {
    const text = await ownedRowsText(attacker.workspaceId);
    for (const marker of markers(victim)) expect(text).not.toContain(marker);
  });
});
