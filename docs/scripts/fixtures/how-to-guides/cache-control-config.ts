// bascik.config.ts: per-extension cache-control, no build step needed.
// Pair immutable with fingerprinted filenames whose content cannot change.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  http: {
    cacheControl: {
      '.woff2': 'public, max-age=31536000, immutable',
      '.png': 'public, max-age=86400',
    },
  },
});
