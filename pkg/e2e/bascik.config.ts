// Identifier minification stays off so Playwright assertions match readable scoped names
// like `bascik__scope-test__active` rather than opaque hashes. Must be set
// explicitly because bascik --build defaults minify.identifiers to true.
import { defineConfig } from '@bascik/bascik/config';
import postcss from 'postcss';
import autoprefixer from 'autoprefixer';
import { transform } from 'esbuild';

export default defineConfig({
  pipeline: {
    watchPaths: ['src/content/'],
    workers: true,
    exec: [
      { script: 'scripts/generate-manifest.ts' },
    ],
  },
  scripts: {
    onBuildScriptError: 'warn',
    onRoutesScriptError: 'warn',
    onServerScriptError: 'warn',
  },
  assets: {
    inlineStyles: ['src/css/inlined-global.css'],
  },
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
});

export const server = defineConfig({
  http: {
    port: Number(process.env.BASCIK_SERVER_PORT || process.env.BASCIK_SERVE_PORT) || 9443,
    tls: {
      enabled: process.env.BASCIK_ENABLE_TLS === 'true',
    },
  },
});
