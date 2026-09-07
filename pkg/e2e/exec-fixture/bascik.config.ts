// Both watches cover source inputs. Generated dist artifacts are never watched.
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
        script: 'scripts/post.mjs',
        phase: 'post',
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