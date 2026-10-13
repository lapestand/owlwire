import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { main: 'src/main.ts' },
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
