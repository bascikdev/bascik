import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    // '../components' is the shared example components folder in the Bascik repository (theme-init, theme-toggle,
    // contact-form). add-example.mjs copies those components into your own src/components, so leave it out.
    components: ['src/components', '../components'],
  },
  pipeline: {
    // Rebuild pages in dev when a post or a build helper changes.
    watchPaths: ['content/', 'src/lib/'],
    exec: [
      // Both read the finished dist/, so they run after compilation.
      { script: 'scripts/feed.ts', phase: 'post', watch: ['content/'] },
      { script: 'scripts/llms-txt.ts', phase: 'post' },
    ],
  },
  scripts: {
    cache: {
      // These pages call getPosts(), which reads a directory. The build script cache keys on files a script names
      // literally, so it cannot see a new or edited post. Exclude every page that lists or renders posts.
      exclude: ['src/pages/blog/**', 'src/pages/index.html'],
    },
  },
});
