import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  assets: {
    inlineStyles: ['src/css/global.css'],
  },
  pipeline: {
    // Pages import src/lib helpers; watch them so an edit rebuilds the pages in dev.
    watchPaths: ['src/lib/'],
    exec: [
      // Gathers every post, page, and image before any page compiles (REST API or content/).
      // The default exec timeout is 60 s; a site with many images needs longer to download them.
      { script: 'scripts/sync-wordpress.ts', phase: 'pre', watch: ['content/'], timeout: 600000 },
      // RSS feed, written after the pages.
      { script: 'scripts/generate-feed.ts', phase: 'post', watch: ['content/'] },
    ],
  },
  scripts: {
    cache: {
      // Pages read the content snapshot, which Bascik cannot see as a dependency. Without this,
      // a rebuild after an edit in WordPress would reuse the previous output.
      exclude: ['src/pages/**', 'src/components/**'],
    },
  },
});
