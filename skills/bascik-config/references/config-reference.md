# Configuration Reference

Every option with its built-in default. This listing is for lookup only: never copy it into a project. A config contains only the values that differ.

```ts
// Reference only: every value below is already the default.
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    pages: 'src/pages',
    components: 'src/components',   // string or string[]
    out: 'dist',
    api: 'src/api',
  },
  components: {
    external: [],                   // third-party custom element tags: exact names or '*' wildcards
  },
  scoping: {
    scriptBlocks: true,             // wrap each client <script> in an IIFE
    inheritAttributes: true,        // forward usage-tag attributes to the first root element
    attributes: { class: true, id: true, name: true },
    preserve: ['code'],             // tags whose subtrees keep literal id, name, class
    deduplicateCss: true,           // one <style> per component type
  },
  minify: {                         // --build and --server turn all four on
    html: false,
    css: false,                     // or an async (css) => string function
    js: false,                      // or an async (js) => string function
    identifiers: false,
  },
  assets: {
    inlineStyles: false,            // or a list of stylesheet paths to inline into <head>
    exclude: [],                    // extra globs relative to directory.pages
    symlink: false,                 // dev only: link unchanged assets instead of copying
  },
  generate: {
    sitemap: true,                  // needs a site URL
    robots: true,                   // needs a site URL
    sitemapLastmod: false,
    cspHashes: false,               // dist/.bascik/csp-hashes.json with sha256 hashes of inline blocks
    manifest: false,                // dist/.bascik/manifest.json inventory of emitted files
  },
  pipeline: {
    watchPaths: [],                 // extra files or folders that rebuild pages in dev
    exec: [],                       // lifecycle scripts { script, phase, watch, cwd, env, args, timeout }
    workers: false,                 // compile pages in a worker pool
    onExecError: 'warn',            // 'warn' in dev, 'error' for --build
  },
  scripts: {
    cache: { enabled: true },       // also include, exclude, environment
    typescript: true,               // browser TS compiler: true | false | function
    onBuildScriptError: 'error',    // 'error' | 'warn' | 'ignore'
    onRoutesScriptError: 'error',
    onServerScriptError: 'error',
    timeout: 30000,                 // ms per build or server script
    importRoot: 'src',              // what @/ resolves against
  },
  onMinifyError: 'warn',            // 'error' under --build and --server
  http: {
    port: undefined,                // 8080 (HTTP) or 8443 (TLS); dev falls through to the next free port
    hostname: 'localhost',          // '0.0.0.0' binds all interfaces
    tls: { enabled: false, keyFile: undefined, certFile: undefined },
    httpCache: false,               // true under --server: strong content-hash ETags and 304s
    rateLimit: true,                // 500 requests / 10 s per IP under --server, or { window, max }
    trustProxy: false,
    cacheControl: 'public, max-age=3600',
    compression: true,
    precompress: false,             // --build writes .br/.gz sidecars for --server
    timeouts: { request: 30000, headers: 10000, keepAlive: 5000, drain: 5000 },
    maxBodySize: 1048576,           // API request body limit in bytes
    apiTimeout: 10000,              // API handler limit in ms
  },
  logging: {
    level: 'info',                  // silent | error | warn | info | debug
    requests: true,
    copies: true,
    deletes: true,
    transpiles: true,
  },
  base: '/',
});
```

## Validation

- Unknown keys fail with a suggestion (`minfy` suggests `minify`). Every error names the key, the value received, and the expectation.
- Referenced paths are checked: `directory.pages`, `pipeline.exec[].script`, `pipeline.watchPaths`, `assets.inlineStyles`, and TLS files.
- `base` is normalized to leading and trailing slashes (`docs` becomes `/docs/`); a full URL is rejected.
- `siteUrl` anywhere in the config is rejected with instructions for `--site-url`, `BASCIK_SITE_URL`, and `.env`.

## Exec cycle semantics

- Phases: `pre` finishes before compilation; `parallel` starts alongside compilation; `post` starts after compilation and disk writes.
- In dev, an edit is one cycle that coalesces exec `watch` matches with pages, components, and `pipeline.watchPaths`. Known dependents rebuild once; unknown external dependencies conservatively rebuild every page without rerunning unmatched scripts.
- Script completion never queues another compile or reload. Edits made while work is running are retained; failed paths retry on the next source edit. A `pre`, compile, or `post` failure discards the success reload.
- Dev `parallel` scripts do not block and report every failure; `--build` waits for `parallel` and `post` before reporting success.
- Bascik cannot detect a script that writes into its own watched sources; that loop is the author's bug. `scripts.importRoot` and `assets.inlineStyles` do not add compilation watches.
- The default exec timeout is 60 seconds; raise `timeout` on entries that download media.

## `minify.js` and `minify.css`

`true` strips comments and collapses whitespace; it does not mangle identifiers. Pass an async function to use another tool. The JavaScript function always receives valid JavaScript (browser TypeScript is stripped first), and Bascik re-attaches its `//# sourceURL` line afterward, so minifiers that drop comments are safe.

```ts
// bascik.config.ts (illustrative)
import { transform } from 'esbuild';
import { defineConfig } from '@bascik/bascik/config';

export const build = defineConfig({
  minify: {
    js: async (js) => (await transform(js, { minify: true, loader: 'js' })).code,
  },
});
```

Never add a `minify.js` function only to strip TypeScript; Bascik already does that. For a different TypeScript compiler, use `scripts.typescript`.

## HTML minification

Comments are removed and excess whitespace collapses. Content inside `<pre>`, `<textarea>`, `<script>`, and `<style>`, every attribute value, and non-breaking spaces are left alone. CSS is not consulted, so an element styled `white-space: pre` that is not a `<pre>` loses its extra whitespace; use `<pre>`.

## `assets.inlineStyles`

A list of stylesheets (for example `['src/pages/css/styles.css']`) injected into every page's `<head>`, removing a render-blocking request. Inlined files are not copied to `dist/`.

## Content Security Policy

Bascik never sets a `Content-Security-Policy` header. `generate.cspHashes: true` writes SHA-256 hashes of every inline script and style per page to `dist/.bascik/csp-hashes.json`; apply the header at the host or proxy.
