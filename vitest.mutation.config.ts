import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// Test selection for mutation testing (stryker.config.mjs): only the tests that exercise the mutated modules,
// so the initial run stays short. Stryker then runs, per mutant, only the tests that cover that mutant.
const unit = [
  'packages/crypto/src/**/*.test.ts',
  'packages/core/src/redaction*.test.ts',
  'packages/db/src/client.test.ts',
  'packages/db/src/repos/audit*.test.ts',
  'apps/server/src/logger*.test.ts',
];
// Tenant scoping and the audit write path are only observable against Postgres (RLS, SET LOCAL, transactions).
const int = [
  'packages/db/src/scope.int.test.ts',
  'packages/db/src/cross-tenant.int.test.ts',
  'packages/db/src/repos/audit.int.test.ts',
];

/**
 * Stryker 10.0 runs each mutant against the tests that cover it by setting testNamePattern to their names joined
 * with spaces ("suite test"), but vitest 5 matches "suite > test". Without this shim no test matches, nothing
 * runs and every mutant is reported as survived. Each space in Stryker's pattern also accepts " > ", which may
 * select a few extra tests but never misses one.
 */
const strykerTestNames = {
  name: 'owlwire:stryker-test-names',
  configureVitest({ project }: { project: { config: { testNamePattern?: RegExp | string } } }) {
    let pattern: RegExp | string | undefined = project.config.testNamePattern;
    Object.defineProperty(project.config, 'testNamePattern', {
      configurable: true,
      enumerable: true,
      get: () => pattern,
      set: (value: RegExp | string | undefined) => {
        pattern =
          value instanceof RegExp
            ? new RegExp(value.source.replaceAll(' ', '(?: | > )'), value.flags)
            : value;
      },
    });
  },
};

export default defineConfig({
  plugins: [strykerTestNames],
  resolve: base.resolve,
  test: {
    // At the root, not in the int project: a project-level globalSetup replaces the one Stryker adds to the
    // root config to switch mutants, and the integration tests then silently run against unmutated code.
    globalSetup: [
      fileURLToPath(new URL('./packages/testing/src/global-setup.ts', import.meta.url)),
    ],
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: unit, exclude: ['**/node_modules/**', '**/*.int.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'int',
          include: int,
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
