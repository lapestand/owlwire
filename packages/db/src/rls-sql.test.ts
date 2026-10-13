import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tenantPolicySql } from './rls-sql.js';

const TENANT_TABLES = [
  'connections',
  'destinations',
  'installations',
  'rules',
  'rule_targets',
  'events',
  'deliveries',
  'workspace_keys',
  'audiences',
  'audience_members',
  'digests',
  'connection_counters',
  'audit_log',
];

describe('tenantPolicySql', () => {
  it('enables RLS and creates <table>_tenant_isolation on workspace_id', () => {
    expect(tenantPolicySql('audiences')).toBe(
      [
        'ALTER TABLE "audiences" ENABLE ROW LEVEL SECURITY;',
        '--> statement-breakpoint',
        'CREATE POLICY "audiences_tenant_isolation" ON "audiences"',
        '  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));',
      ].join('\n'),
    );
  });

  it('never forces RLS on the table owner', () => {
    expect(tenantPolicySql('audiences')).not.toMatch(/FORCE/i);
  });

  it.each(['', 'Audiences', 'a;drop table x', 'a b', '"a"'])(
    'rejects unsafe table name %j',
    (name) => {
      expect(() => tenantPolicySql(name)).toThrow(RangeError);
    },
  );

  it('is used verbatim by the rls_policies migration for every tenant table', () => {
    const dir = fileURLToPath(new URL('../drizzle', import.meta.url));
    const file = readdirSync(dir).find((f) => f.endsWith('_rls_policies.sql'));
    expect(file).toBeDefined();
    const sql = readFileSync(`${dir}/${file}`, 'utf8');
    for (const table of TENANT_TABLES) expect(sql).toContain(tenantPolicySql(table));
  });
});
