const TABLE_RE = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * R37: workspace_id kolonlu bir kiracı tablosu için standart RLS bloğu. Custom migration'a (drizzle-kit
 * `--custom`) olduğu gibi yapıştırılır; politika tablonun oluştuğu migration'dadır. FORCE kullanılmaz.
 */
export function tenantPolicySql(table: string): string {
  if (!TABLE_RE.test(table)) throw new RangeError(`unsafe table name: ${JSON.stringify(table)}`);
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    '--> statement-breakpoint',
    `CREATE POLICY "${table}_tenant_isolation" ON "${table}"`,
    '  USING (owlwire_private.rls_allows(workspace_id)) WITH CHECK (owlwire_private.rls_allows(workspace_id));',
  ].join('\n');
}
