import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const alias = [
  { find: /^@owlwire\/core\/message$/, replacement: r('./packages/core/src/message.ts') },
  { find: /^@owlwire\/core$/, replacement: r('./packages/core/src/index.ts') },
  { find: /^@owlwire\/crypto$/, replacement: r('./packages/crypto/src/index.ts') },
  { find: /^@owlwire\/db\/migrate$/, replacement: r('./packages/db/src/migrate-all.ts') },
  { find: /^@owlwire\/db\/system$/, replacement: r('./packages/db/src/system/index.ts') },
  { find: /^@owlwire\/db$/, replacement: r('./packages/db/src/index.ts') },
  {
    find: /^@owlwire\/testing\/fixtures$/,
    replacement: r('./packages/testing/src/fixtures/index.ts'),
  },
  { find: /^@owlwire\/testing$/, replacement: r('./packages/testing/src/index.ts') },
  { find: /^@owlwire\/contracts$/, replacement: r('./packages/contracts/src/index.ts') },
  { find: /^@owlwire\/adapter-sdk$/, replacement: r('./packages/adapter-sdk/src/index.ts') },
  {
    find: /^@owlwire\/adapter-telegram$/,
    replacement: r('./packages/adapters/telegram/src/index.ts'),
  },
];

const exclude = ['**/node_modules/**', '**/dist/**'];

export default defineConfig({
  resolve: { alias },
  test: {
    // Informational only (`pnpm test:coverage`): no thresholds. One run covers both projects, so unit and
    // integration coverage are merged into a single report.
    coverage: {
      provider: 'v8',
      include: ['{apps,packages}/**/src/**/*.{ts,tsx}', 'scripts/**/*.mjs'],
      exclude: [
        ...exclude,
        '**/*.test.ts',
        '**/__test__/**',
        '**/test/**',
        'packages/testing/**',
        '**/drizzle/meta/**',
        '**/*.d.ts',
      ],
      reporter: ['text-summary', 'json-summary', 'json'],
      reportsDirectory: 'coverage',
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: [
            '{apps,packages}/**/src/**/*.test.ts',
            'src/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
          exclude: [...exclude, '**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'int',
          include: ['{apps,packages}/**/src/**/*.int.test.ts', 'src/**/*.int.test.ts'],
          exclude,
          globalSetup: [r('./packages/testing/src/global-setup.ts')],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
