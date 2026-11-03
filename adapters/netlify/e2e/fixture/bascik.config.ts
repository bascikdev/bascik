import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  generate: { sitemap: false, robots: false },
  scripts: { timeout: 10_000 },
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'", "'unsafe-inline'"],
      "connect-src": ["'self'"],
      "img-src": ["'self'", "data:"],
    },
  },
});
