// Mutation testing for the security-critical modules (`pnpm test:mutation`, weekly in the Mutation workflow).
// It answers "would the tests notice if this code were wrong?" for tenant scoping, crypto, the audit secret
// guard and log redaction. Kept narrow on purpose so a full run stays short.
export default {
  // Named explicitly: pnpm's isolated node_modules hides the runner from Stryker's default plugin glob.
  plugins: ['@stryker-mutator/vitest-runner'],
  testRunner: 'vitest',
  // related: false because vitest's related-file lookup misses the integration test files.
  vitest: { configFile: 'vitest.mutation.config.ts', related: false },
  // Per-test coverage: each mutant only runs the tests that execute its code. With vitest 5 this relies on the
  // test-name shim in vitest.mutation.config.ts.
  coverageAnalysis: 'perTest',
  mutate: [
    'packages/db/src/scope.ts',
    'packages/crypto/src/aead.ts',
    'packages/crypto/src/dek.ts',
    'packages/crypto/src/keyring.ts',
    'packages/db/src/repos/audit.ts',
    'packages/core/src/redaction.ts',
    'apps/server/src/logger.ts',
  ],
  // Reuses earlier results for unchanged code and tests; the workflow restores this file from the cache.
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  reporters: ['clear-text', 'progress', 'json', 'html'],
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  htmlReporter: { fileName: 'reports/mutation/mutation.html' },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
  // Informational: the score is reported, never enforced.
  thresholds: { high: 80, low: 60, break: null },
  timeoutMS: 60_000,
  // Each runner process starts its own Postgres container for the integration tests; 4 matches a CI runner.
  concurrency: 4,
};
