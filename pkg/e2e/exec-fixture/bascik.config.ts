// Exec producer/consumer lifecycle fixture (prompt 109).
//
// A pre-phase producer `scripts/generator.mjs` writes `dist/generated.json`
// (kept out of src/). A page build script reads that literal path via
// `readFileSync` and prints its `value`. Both the generator's watch globs and
// `pipeline.watchPaths` cover `content/`, which is the overlap contract under
// test: on a `content/` edit the producer must finish BEFORE the page
// re-transpiles, exactly once.
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    pages: 'src/pages',
    components: ['src/components'],
  },
  pipeline: {
    watchPaths: ['content/'],
    exec: [
      {
        script: 'scripts/generator.mjs',
        phase: 'pre',
        watch: ['content/'],
      },
    ],
  },
  scripts: {
    onBuildScriptError: 'warn',
  },
  minify: {
    identifiers: false,
  },
});