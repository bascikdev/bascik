import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  // The upstream example is a single widget with no site URL, sitemap, or robots.txt.
  generate: { sitemap: false, robots: false },
  pipeline: {
    // Pages import src/lib helpers from build scripts. Rebuild them in development.
    watchPaths: ['src/lib/', 'src/data/'],
  },
});
