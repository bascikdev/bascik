import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  assets: {
    // Inlined into every page head, like the upstream per-page CSS bundle.
    inlineStyles: ['src/css/global.css'],
  },
  pipeline: {
    // Build scripts import src/lib helpers and read content/. Watch both so an edit to
    // either rebuilds the pages that use them.
    watchPaths: ['content/', 'src/lib/'],
    exec: [
      // Copies images stored beside posts to the same path in dist/ (Eleventy does this
      // through its image transform). 'pre' so the files exist before pages are checked.
      { script: 'scripts/copy-content-assets.ts', phase: 'pre', watch: ['content/'] },
      // Atom feed. Runs after pages so dist/ exists.
      { script: 'scripts/generate-feed.ts', phase: 'post', watch: ['content/'] },
    ],
  },
  scripts: {
    cache: {
      // Cached output is keyed by script text and detected imports. Scripts that read
      // content/ depend on files Bascik cannot see, so they must run on every build.
      exclude: ['src/pages/**', 'src/components/**'],
    },
  },
});
