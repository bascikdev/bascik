// Fixture site for the Cloudflare adapter E2E lane (prompts 134/135).
// Built with `bascik --build --target cloudflare-pages` and served by
// `serve.ts` inside local workerd (Miniflare) with the asset layer in front.
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: { components: ['src/components'] },
  generate: { sitemap: false, robots: false },
  // Readable scoped names are irrelevant here: every assertion uses data-testid.
  scripts: { onServerScriptError: 'error', timeout: 10_000 },
});
