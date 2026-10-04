import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  assets: {
    // The global stylesheet is inlined into every page head, like the upstream
    // `import '../styles/global.css'` inside BaseHead.
    inlineStyles: ['src/css/global.css'],
  },
  pipeline: {
    // Build scripts import src/lib helpers and read content/. Watch both in development.
    watchPaths: ['content/', 'src/lib/'],
    exec: [
      // Equivalent of src/pages/rss.xml.js. Runs after pages so it can write into dist/.
      { script: 'scripts/generate-feed.ts', phase: 'post', watch: ['content/'] },
    ],
  },
  scripts: {
    cache: {
      // Cached output is keyed by script text and detected imports. Scripts that read the
      // content/ directory, and the footer's current-year read, depend on inputs Bascik
      // cannot see, so they must re-run on every build.
      exclude: [
        'src/components/site-footer/**',
        'src/components/post-list/**',
        'src/pages/blog/**',
      ],
    },
  },
});
