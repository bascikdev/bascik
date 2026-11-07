import { defineConfig } from "@bascik/bascik/config";

export default defineConfig({
  minify: true,
  http: { apiTimeout: 45_000, maxBodySize: 262_144 },
  assets: { inlineStyles: ["src/pages/assets/styles.css"] },
  pipeline: {
    watchPaths: ["catalog/", "src/lib/", "src/browser/"],
    exec: [
      {
        script: "scripts/build-assets.ts",
        phase: "post",
        watch: [
          "src/browser/",
          "src/components/",
          "src/lib/catalog.ts",
          "catalog/",
          "../docs/src/pages/assets/bascik-logo.svg",
          "../docs/src/pages/assets/favicon.svg",
        ],
      },
    ],
  },
  contentSecurityPolicy: {
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "style-src": ["'self'"],
      "img-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
      "base-uri": ["'none'"],
      "form-action": ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
});
