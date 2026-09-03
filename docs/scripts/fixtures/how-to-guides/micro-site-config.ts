// bascik.config.ts: a micro site needs almost nothing.
// Defaults are correct; this file can even be omitted entirely.
import { defineConfig } from '@bascik/bascik';

export default defineConfig({
  // generate.sitemap and generate.robots default to true; disable them
  // for a single-page site with no SEO surface.
  generate: { sitemap: false, robots: false },
});
