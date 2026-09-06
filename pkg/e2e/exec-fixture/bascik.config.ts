// Exec producer/consumer lifecycle fixture (prompt 109).
//
// A pre-phase producer `scripts/generator.mjs` writes `dist/generated.json`
// (kept out of src/). A page build script reads that literal path via
// `readFileSync` and prints its `value`. Both the generator's watch globs and
// `pipeline.watchPaths` cover `content/`, which is the overlap contract under
// test: on a `content/` edit the producer must finish BEFORE the page
// re-transpiles, exactly once.
//
// A second, `phase: 'parallel'` producer `scripts/parallel-generator.mjs`
// writes `dist/parallel.json` (prompt 137). In dev it runs alongside the
// server instead of blocking boot; when BASCIK_PARALLEL_GATE=1 it holds behind
// an HTTP gate so the E2E can prove the server was live before it finished and
// that its value is published once through the coordinator on release.
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
      {
        script: 'scripts/parallel-generator.mjs',
        phase: 'parallel',
        // The gated run holds this child until the test releases it; keep the
        // deadline comfortably above the suite's runtime so the hold is never
        // misreported as a timeout.
        timeout: 120_000,
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