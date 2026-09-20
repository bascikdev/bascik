import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  assets: {
    symlink: true,
  },
  generate: {
    sitemap: false,
    robots: false,
  },
});