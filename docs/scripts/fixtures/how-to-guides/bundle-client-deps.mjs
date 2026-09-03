// build-bundle.mjs: bundles client dependencies into dist/assets/js/.
// Run as a pipeline.exec step with phase: 'pre' so the bundle exists
// before pages are transpiled and referenced.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/client/confetti-entry.mjs'],
  bundle: true,
  format: 'esm',
  minify: true,
  outfile: 'dist/assets/js/confetti-bundle.mjs',
});
