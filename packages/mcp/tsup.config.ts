import { defineConfig } from 'tsup';

/**
 * One runnable ESM bundle. The workspace packages export TypeScript source, so
 * they and their pure-JS dependencies are bundled in. Packages listed under
 * `dependencies` (pdf.js and the native canvas) stay external.
 */
export default defineConfig({
  entry: { bin: 'src/bin.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  sourcemap: false,
  noExternal: [/^@sign-pdf\//],
  banner: { js: '#!/usr/bin/env node' },
});
