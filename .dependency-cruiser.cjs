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
      from: { path: '^packages/db/', pathNot: '\\.test\\.ts$' },
      to: { path: '^packages/', pathNot: '^packages/(db|core|crypto)/' },
    },
    {
      name: 'packages-not-to-apps',
      severity: 'error',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
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
