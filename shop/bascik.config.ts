import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  minify: true,
  http: { apiTimeout: 45_000, maxBodySize: 262_144 },
  assets: { inlineStyles: ["src/pages/assets/styles.css"] },
  pipeline: {
    watchPaths: ["catalog/", "src/lib/"],
  },
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'", "https://js.stripe.com"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'", "https://api.stripe.com"],
      "frame-src": ["https://js.stripe.com", "https://hooks.stripe.com"],
      "base-uri": ["'none'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
});
