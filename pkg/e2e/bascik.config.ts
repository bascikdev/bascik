// Identifier minification stays off so Playwright assertions match readable scoped names
// like `bascik__scope-test__active` rather than opaque hashes. Must be set
// explicitly because bascik --build defaults minify.identifiers to true.
import { defineConfig } from '@bascik/bascik/config';
import postcss from 'postcss';
import autoprefixer from 'autoprefixer';
import { transform } from 'esbuild';

export default defineConfig({
  siteUrl: 'http://localhost:4200',
  watch: ['src/content/'],
  useWorkers: true,
  onScriptError: 'warn',
  inlineStyles: ['src/css/inlined-global.css'],
  minify: {
    identifiers: false,
    css: async (css) => {
      const result = await postcss([autoprefixer]).process(css, { from: undefined });
      return result.css;
    },
    js: async (code) => {
      const result = await transform(code, { loader: 'js', minify: true });
      return result.code;
    },
  },
  exec: [
    { script: 'scripts/generate-manifest.ts' },
  ],
  prodServer: {
    port: Number(process.env.BASCIK_SERVE_PORT) || 9443,
    enableTls: process.env.BASCIK_ENABLE_TLS === 'true',
  },
});
