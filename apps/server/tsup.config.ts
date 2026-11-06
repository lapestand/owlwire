import { defineConfig } from 'tsup';

export default defineConfig({
  // The payload schema worker is its own entry: PayloadSchemaRegistry starts it from dist/ by
  // file name (payload-schema-worker.js next to main.js).
  entry: {
    main: 'src/main.ts',
    'payload-schema-worker': 'src/services/payload-schema-worker.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  splitting: false,
  // Workspace packages are bundled; npm dependencies listed in package.json stay external.
  noExternal: [/^@owlwire\//],
  // Only the adapter-sdk conformance kit imports vitest; it is tree-shaken (sideEffects: false).
  external: ['vitest'],
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __owlwireCreateRequire } from 'node:module';",
      'const require = __owlwireCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});
