/**
 * Bundle step (stage 1 of the release pipeline):
 *   node build.mjs            → dist/bin.js  (single-file ESM, no sourcemap — contract §2.1)
 * Stage 2 compiles per-platform binaries:
 *   bun build dist/bin.js --compile --target=bun-<os>-<arch> --outfile geoly
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/bin.js',
  sourcemap: false, // .map files must never ship (Claude Code leak lesson)
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});
console.log('bundled → dist/bin.js');
