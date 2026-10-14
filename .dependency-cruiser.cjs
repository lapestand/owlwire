/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: 'web-only-contracts',
      comment: 'apps/web yalnizca @owlwire/contracts paketine baglanabilir',
      severity: 'error',
      from: { path: '^apps/web/' },
      to: { path: '^packages/', pathNot: '^packages/contracts/' },
    },
    {
      name: 'adapters-boundary',
      comment: 'adaptorler yalnizca adapter-sdk ve core/message gorur',
      severity: 'error',
      from: { path: '^packages/adapters/([^/]+)/', pathNot: '\\.test\\.ts$' },
      to: {
        path: '^packages/',
        pathNot: [
          '^packages/adapter-sdk/',
          '^packages/core/src/message\\.ts$',
          '^packages/adapters/$1/',
        ],
      },
    },
    {
      name: 'adapter-sdk-boundary',
      comment: 'adapter-sdk yalnizca core paketine baglanabilir',
      severity: 'error',
      from: { path: '^packages/adapter-sdk/', pathNot: '\\.test\\.ts$' },
      to: { path: '^packages/', pathNot: '^packages/(adapter-sdk|core)/' },
    },
    {
      name: 'core-no-workspace-deps',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: { path: '^packages/', pathNot: '^packages/core/' },
    },
    {
      name: 'core-no-node-io',
      severity: 'error',
      from: { path: '^packages/core/', pathNot: '\\.test\\.ts$' },
      to: {
        dependencyTypes: ['core'],
        path: '^(node:)?(fs|fs/promises|net|http|https|http2|tls|dgram|dns|child_process|worker_threads)$',
      },
    },
    {
      name: 'core-no-io-packages',
      severity: 'error',
      from: { path: '^packages/core/' },
      to: {
        path: 'node_modules/(pg|postgres|drizzle-orm|graphile-worker|grammy|hono|pino)/',
      },
    },
    {
      name: 'db-boundary',
      severity: 'error',
      from: { path: '^packages/db/', pathNot: '(\\.test\\.ts$|/__test__/)' },
      to: { path: '^packages/', pathNot: '^packages/(db|core|crypto)/' },
    },
    {
      name: 'packages-not-to-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-drizzle-outside-db-package',
      comment: 'Raw Drizzle only inside packages/db/src.',
      severity: 'error',
      from: { path: '^(apps|packages)/', pathNot: ['^packages/db/src/'] },
      to: { path: '(^|/)node_modules/drizzle-orm/' },
    },
    {
      name: 'no-pg-value-import-outside-allowed',
      comment:
        'pg value imports only in packages/db, packages/testing, the server dependency wiring (deps.ts), the worker runner, the planned leader election module, the server test harness and integration tests; import type is free everywhere.',
      severity: 'error',
      from: {
        path: '^(apps|packages)/',
        pathNot: [
          '^packages/db/src/',
          '^packages/testing/src/',
          '^apps/server/src/(deps\\.ts|worker/runner\\.ts|adapters/leader\\.ts|test/)',
          '\\.int\\.test\\.ts$',
        ],
      },
      to: {
        path: '(^|/)node_modules/(pg|pg-pool)/',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'system-scope-only-from-server-system',
      comment: 'SystemScope/withSystem only from packages/db/src and apps/server/src/system.',
      severity: 'error',
      from: { pathNot: ['^apps/server/src/system/', '^packages/db/'] },
      to: { path: '^packages/db/(src|dist)/system/' },
    },
    {
      name: 'migrate-only-from-allowed',
      comment: '@owlwire/db/migrate only from system, test harness and integration tests.',
      severity: 'error',
      from: {
        pathNot: ['^apps/server/src/(system|test)/', '^packages/db/', '\\.int\\.test\\.ts$'],
      },
      to: { path: '^packages/db/(src|dist)/migrate-all\\.' },
    },
    {
      name: 'db-fixtures-only-from-tests',
      comment:
        '@owlwire/db/fixtures seeds test data; only test files and the server test harness may import it.',
      severity: 'error',
      from: {
        pathNot: ['\\.test\\.ts$', '^apps/server/src/test/', '^packages/db/src/fixtures/'],
      },
      to: { path: '^packages/db/(src|dist)/fixtures/' },
    },
    {
      name: 'db-internals-private',
      comment:
        'Only the public entry points of @owlwire/db may be imported from outside the package.',
      severity: 'error',
      from: { pathNot: '^packages/db/' },
      to: {
        path: '^packages/db/(src|dist)/(client|handle|scope|errors|roles|rls-sql|schema/|repos/(?!index\\.)|__test__/)',
      },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)dist/' },
    parser: 'swc',
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['source', 'import', 'types', 'default'],
      mainFields: ['module', 'main', 'types'],
    },
  },
};
