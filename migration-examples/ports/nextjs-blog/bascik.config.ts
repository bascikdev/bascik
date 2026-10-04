import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  pipeline: {
    // Build scripts import src/lib helpers and read _posts/. Watch both in development.
    watchPaths: ['_posts/', 'src/lib/'],
    exec: [
      // Replaces the Next.js PostCSS step (postcss.config.js plus globals.css). Tailwind reads
      // the component templates and src/lib helpers, then writes one stylesheet into the output
      // directory before any page compiles, so every page can link it.
      { script: 'scripts/build-css.ts', phase: 'pre', watch: ['src/components/', 'src/pages/', 'src/lib/', 'src/css/', 'tailwind.config.ts'] },
      // The upstream layout links /feed.xml but never generates it (a 404 there). The port
      // writes the feed it advertises.
      { script: 'scripts/generate-feed.ts', phase: 'post', watch: ['_posts/'] },
    ],
  },
  scripts: {
    cache: {
      // These scripts read _posts/, which Bascik cannot see as an import, so they re-run on
      // every build instead of reusing cached output.
      exclude: ['src/pages/**'],
    },
  },
});
