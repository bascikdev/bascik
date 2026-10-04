import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  assets: {
    // Inlined into every page head.
    inlineStyles: ['src/css/global.css'],
  },
  pipeline: {
    // Build scripts import src/lib helpers and read content/. Watch both so an edit to either
    // rebuilds the pages that use them.
    watchPaths: ['content/', 'src/lib/', 'src/data/'],
    exec: [
      // Copies the images stored beside posts to the same path in dist/. 'pre' so the files
      // exist before pages are checked.
      { script: 'scripts/copy-content-assets.ts', phase: 'pre', watch: ['content/'] },
      // Atom feed at /feed/feed.xml. Runs after pages so dist/ exists.
      { script: 'scripts/generate-feed.ts', phase: 'post', watch: ['content/', 'src/data/'] },
    ],
  },
  scripts: {
    cache: {
      // Cached output is keyed by the script text and the imports Bascik can see. Pages and
      // components here also depend on content/ and on the current date, which it cannot see,
      // so they run on every build.
      exclude: ['src/pages/**', 'src/components/**'],
    },
  },
});
