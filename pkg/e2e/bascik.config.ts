// Identifier minification stays off so Playwright assertions match readable scoped names
// like `bascik__scope-test__active` rather than opaque hashes. Must be set
// explicitly because bascik --build defaults minify.identifiers to true.
import { defineConfig } from '@bascik/bascik/config';
import postcss from 'postcss';
import autoprefixer from 'autoprefixer';
import { transform } from 'esbuild';

export default defineConfig({
  // Two component roots: the default tree plus a shared directory outside
  // src/. Exercises multi-root discovery, watching, and the subfolder
  // companion-script rule for a non-first root (see multi-component-roots.test.ts).
  directory: {
    components: ['src/components', 'shared-components'],
  },
  scoping: {
    preserve: ['pre', 'code'],
  },
  pipeline: {
    watchPaths: ['src/content/', 'src/lib/', 'src/css/'],
    workers: true,
    exec: [
      { script: 'scripts/generate-manifest.ts' },
    ],
  },
  scripts: {
    onBuildScriptError: 'warn',
    onRoutesScriptError: 'warn',
    onServerScriptError: 'warn',
    // Bring-your-own browser TypeScript compiler (prompt 148 follow-on).
    // esbuild with loader 'ts' handles non-erasable syntax (enum) that Node's
    // default strip-only mode rejects; ts-compiler-test depends on that.
    // Runs in worker threads too, which is why it lives in the config file.
    typescript: async (code, { sourcePath }) => {
      const result = await transform(code, { loader: 'ts', target: 'es2020', sourcefile: sourcePath });
      return result.code;
    },
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
    port: Number(process.env.BASCIK_SERVER_PORT) || 9443,
    apiTimeout: 500,
    tls: {
      enabled: process.env.BASCIK_ENABLE_TLS === 'true',
    },
  },
});
