// bascik.config.ts: per-extension cache-control, no build step needed.
// Pair immutable with fingerprinted filenames whose content cannot change.
import { defineConfig } from '@bascik/bascik';

// The runtime accepts a per-extension map (see resolveCacheControl in
// caching.ts), but the UserConfig type only declares the string form.
// Cast until the type catches up with the runtime.
const perExtensionCacheControl = {
  '.woff2': 'public, max-age=31536000, immutable',
  '.png': 'public, max-age=86400',
} as unknown as string;

export default defineConfig({
  http: {
    cacheControl: perExtensionCacheControl,
  },
});
