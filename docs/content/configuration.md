# Configuration

Bascik is **completely zero configuration** by default. You do not need a config file of any kind to start building. Running `bascik` or `bascik --build` works immediately right out of the box, resolving components, scoping CSS and JS, minifying files, and managing routing using sensible, production ready defaults.

However, Bascik is also **highly configurable** for both development and production. Rather than forcing a single architectural opinion on your project, Bascik is designed to put control directly in your hands. Whenever a technical choice involves trade-offs, Bascik exposes fine-grained preferences so you can tailor the build pipeline to your exact workflow.

To override any default behaviors, create a `bascik.config.ts` file in your project root. Import `defineConfig` for full autocomplete and type checking on every option. Your editor will surface valid values, flag typos, and show inline docs as you type. A plain `bascik.config.js` also works and takes precedence if both files exist.

## Default Configuration Example

Because Bascik is zero-config, you do not need a `bascik.config.ts` file to use these settings. The example below displays all available configuration options populated with their built-in default values for illustrative purposes.

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  directory: {
    pages: 'src/pages',
    components: 'src/components',
  },
  watch: [],
  exec: [
    // { script: 'scripts/generate-search-index.ts', watch: ['content/'] },
  ],

  scopeScriptBlocks: true,
  inheritAttributes: true,
  scopeAttribute: {
    class: true,
    id: true,
    name: true,
  },
  skipTranspilingElementContents: ['code'],

  deduplicateCss: true,
  minify: {
    html: false,        // false in dev; true in --build and --serve
    css: false,         // false in dev; true in --build and --serve
    js: false,          // false in dev; true in --build and --serve
    identifiers: false, // false in dev; true in --build and --serve
  },
  inlineStyles: false,  // false | true | ['src/css/styles.css']

  cacheHttp: false,     // false in dev; true in --serve

  siteUrl: undefined,   // e.g. 'https://example.com' (required for sitemap generation)
  generate: {
    sitemap: true,
    robots: true,
  },

  useWorkers: false,
  buildScriptCache: true,
  onScriptError: 'warn', // 'warn' in dev; 'error' in --build and --serve
  onMinifyError: 'warn', // 'warn' in dev; 'error' in --build and --serve

  devServer: {
    logging: {
      level: 'info',      // silent | error | warn | info | debug
      requests: true,
      copies: true,
      deletes: true,
      transpiles: true,
    },
  },

  prodServer: {
    port: 8080,           // default (8080 HTTP, 8443 HTTPS)
    hostname: 'localhost', // use '0.0.0.0' to bind all interfaces
    enableTls: false,     // default; set true for HTTP/2 HTTPS
    scriptTimeout: 30000, // max execution time (ms) per server script
    keyFile: undefined,   // path to TLS private key when enableTls is true
    certFile: undefined,  // path to TLS certificate when enableTls is true
    logging: {
      level: 'info',      // silent | error | warn | info | debug
      requests: true,     // log each request as 'GET / ... 200 17ms'
    },
  },
});

export const build = defineConfig({
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
});
```

## The Power of Preference

Here are just a few ways Bascik puts architectural choices back in your hands:

- **Style Deduplication (`deduplicateCss`):** Choose between clean, single-definition scoped stylesheets for optimal payload sizes, or individual per-instance styling for seamless local script querying.
- **Custom Minification (`minify`):** Toggle HTML, CSS, and JS minifiers independently. You can even plug in your own custom async minifiers (like esbuild or terser) or configure Node's built-in type stripper for native TypeScript compilation.
- **Granular Attribute Scoping (`scopeAttribute`):** Control exactly which attributes (classes, IDs, or name attributes) are scoped. If you are using Tailwind CSS, you can disable class scoping entirely while keeping ID scoping active.
- **Parallel Builds (`useWorkers`):** Optimize build speeds on larger sites by opting into a multi-core CPU worker pool, or stick to main-thread processing for smaller projects.
- **Error Behavior (`onScriptError`):** Choose whether to halt the entire build on template script errors, or output inline compiler warnings and keep going.
- **Environment Overrides (`build`):** Easily define production-only overrides (such as minifying identifier names or inlining stylesheets) while keeping development logs detailed and verbose.

## Configuration Reference

### `directory`

Paths to your pages and components directories, relative to the project root.

```ts
directory: {
  pages: 'src/pages',           // default — HTML routes, static assets, and subfolders
  components: 'src/components', // default — component .html and .css templates
}
```

> **Asset Mirroring and Exclusions:** Any subfolders and static asset files inside `pages` (such as `images/`, `fonts/`, favicons, or standalone `css/` and `js/` files) are automatically copied to `dist/` preserving their folder structure. CSS and JS files in `pages` are minified during build when `minify.css` / `minify.js` are enabled.
>
> The following files are **excluded** from static asset copying and are never copied to `dist/`:
> - `.html` page templates (transpiled into compiled HTML output pages)
> - `.ts` files (treated as build or server helper scripts)
> - Test files matching `*.test.*` or `*.spec.*` (e.g. `styles.test.ts`)
> - Inlined stylesheets specified in `inlineStyles` (injected directly into HTML `<head>` blocks)
> - All files in `src/components/` (treated as source-only component templates and styles)

### `scopeScriptBlocks`

Wrap component `<script>` tags in an IIFE and rewrite scoped attribute references. Set to `false` if you want raw unmodified script output.

```ts
scopeScriptBlocks: true // default
```

### `inheritAttributes`

Control whether non-`data-bascik-*` attributes on a component usage tag are merged onto the component root element. Defaults to `true`.

```ts
inheritAttributes: true // default
```

### `scopeAttribute`

Control which HTML attribute types are scoped independently. Useful if you're using Tailwind (`class: false`) or don't need name scoping.

```ts
scopeAttribute: {
  class: true, // default
  id: true,    // default
  name: true,  // default
}
```

### `deduplicateCss`

When `true` (default), all instances of the same component share the same scoped class names so the compiled `<style>` block is emitted only once per component type, regardless of how many times the component appears on the page.

When `false`, every instance gets its own unique per-instance class names (the same scheme used for `id` scoping). This means a `querySelector('.myClass')` inside a component script will naturally target only elements inside that specific instance, but each instance emits its own `<style>` block.

```ts
deduplicateCss: true // default
```

> **Further Reading & Trade-offs:** For a full side-by-side trade-off breakdown, visual comparison of generated HTML/CSS payloads, and script-querying guides, see the [deduplicateCss Trade-Off Comparison on the Scoped Styles page](/scoped-styles#deduplicatecss-trade-off-comparison).

### `skipTranspilingElementContents`

An array of HTML element names whose inner content is left untouched by the scoping pipeline. Attribute values, element-selector class injection, and JS selector rewriting are all skipped for any HTML found *inside* these elements. The elements' own opening-tag attributes (e.g. `class="cblock-body"` on `<code>` itself) are still scoped normally.

Defaults to `["code"]`: the typical element used to display literal code examples. Add `"pre"` only if your templates contain raw text inside `<pre>` blocks that aren't wrapped in `<code>` and whose content has attribute patterns you don't want scoped. Note: when `"pre"` is in the list, attributes on elements *inside* `<pre>` (such as `class="cblock-body"` on a `<code>` child) are also excluded from scoping.

```ts
skipTranspilingElementContents: ['code'] // default
```

Set to an empty array to disable the protection entirely, or extend the list for other elements whose contents should be preserved as-is.

### `minify` (BYOMinifier)

Configure minification toggles for HTML, CSS, and JS outputs. All three default to `false` in dev mode and `true` during `bascik --build` and `bascik --serve`.

Bascik supports **BYOMinifier (Bring Your Own Minifier)**: both `css` and `js` accept custom async-capable minifier or transformer functions. Plug in PostCSS with Autoprefixer, LightningCSS, esbuild, terser, or Node's built-in TypeScript type stripper:

```ts
// bascik.config.ts
import { defineConfig } from '@bascik/bascik/config';
import autoprefixer from 'autoprefixer';
import postcss from 'postcss';
import { transform } from 'esbuild';

export const build = defineConfig({
  minify: {
    html: true,
    css: async (css) => {
      const result = await postcss([autoprefixer]).process(css, { from: undefined });
      return result.css;
    },
    js: async (code) => {
      const result = await transform(code, { minify: true, loader: 'js' });
      return result.code;
    },
  },
});
```

Only applies to inline scripts (those without a `src` attribute) and to `.js` files copied into `dist/`. Non-JS script types such as `application/ld+json` are always left untouched.

To strip TypeScript from component scripts, pass Node's built-in `stripTypeScriptTypes` to `minify.js`. See [TypeScript in Component Scripts](/scoped-javascript#typescript-in-component-scripts).

### `minify.identifiers`

Hash generated class, ID, and name attributes (name compression or mangling) to short alphanumeric strings instead of the verbose `bascik__component__id__name` format. Enabled by default in builds.

```ts
minify: {
  identifiers: true // production default
}
// bascik__my-nav__ab12cd34__navigation
// becomes: b2Y4G9eD1K8b
```

### `cacheHttp`

Controls HTTP caching on server responses. Defaults to `false` in dev mode and `true` in `--serve` (production) mode, you rarely need to set this explicitly.

When `true`, HTML pages receive an `ETag` header and the server returns `304 Not Modified` for unchanged content. Static assets get `Cache-Control: public, max-age=3600`. When `false`, responses include `Cache-Control: no-store` so browsers always fetch fresh content.

Set `cacheHttp: false` explicitly when running `--serve` behind a CDN that manages its own caching.

### Build logs

Bascik can write a copy of the build output to a file when you enable it from the CLI. This is meant for debugging and CI diagnosis, not as a normal project artifact.

```sh
bascik --build --log
bascik --build --log ./logs/build.log
```

The default path is `.bascik/build.log`. If you omit `--log`, Bascik does not create a file automatically. Terminal output remains the primary source of build diagnostics.

### `devServer`

Control the noise level of the development server's status output. The `level` field applies to all dev-server status events; individual toggles let you silence only the logs you do not want.

```ts
devServer: {
  logging: {
    level: 'info',      // silent | error | warn | info | debug
    requests: true,     // log each page request as 'serving: ...'
    copies: true,       // log each static file copied into dist/
    deletes: true,      // log each dist/ file or dir deleted
    transpiles: true,   // log each page transpile
  },
}
```

Use `level: 'warn'` or `level: 'silent'` to suppress the high-volume status lines when you are focused on application logic rather than build output.

### `prodServer`

Configure the HTTP server started by `bascik --serve` and `bascik` (dev mode). `port`, `hostname`, `enableTls`, `rateLimit`, `scriptTimeout`, `keyFile`, and `certFile` are read in both modes. `bascik --build` does not start a server and ignores this block.

```ts
prodServer: {
  port: 8080,              // default (8080 for HTTP, 8443 for HTTPS)
  hostname: 'localhost',   // default; set '0.0.0.0' to bind all interfaces
  enableTls: false,        // default; set true for encrypted HTTP/2 (HTTPS)
  rateLimit: true,         // default; enable per-IP rate limiting (500 req / 10s)
  scriptTimeout: 30000,    // max execution time (ms) per server script (default: 30000)
  keyFile: 'bascik-privkey.pem',  // path to TLS private key when enableTls: true
  certFile: 'bascik-cert.pem',    // path to TLS certificate when enableTls: true
  logging: {
    level: 'info',        // silent | error | warn | info | debug
    requests: true,       // log each request as 'GET / ... 200 17ms'
  },
}
```

See [Production Server](/server) for the full guide.

### `siteUrl`

The canonical base URL of your deployed site (e.g. `'https://example.com'`). Required for sitemap generation. Trailing slashes are trimmed automatically.

```ts
siteUrl: 'https://example.com'
```

### `generate`

Control which files are written to `dist/` during `bascik --build`. Both default to `true`. Requires `siteUrl` to be set.

```ts
generate: {
  sitemap: true, // write dist/sitemap.xml
  robots: true,  // write dist/robots.txt
}
```

See [Sitemap & robots.txt](/sitemap) for a full walkthrough.

### `watch`

An array of directories or files that, when changed in dev mode, trigger a full re-transpile of all pages. Useful for utility scripts, data files, or image directories that pages depend on at build time.

```ts
watch: ['scripts/', 'data/'],
```

Has no effect during `bascik --build`.

### `exec`

Scripts to run as part of the build/dev lifecycle. Entries execute sequentially in array order before page transpilation during `--build`. Each entry has a `script` path (relative to the project root, run with the same `node` binary) and an optional `watch` array.

- **With `watch`**: runs on dev startup (non-blocking) and re-runs whenever a watched file changes, followed by a live-reload. Also runs before pages during `--build`.
- **Without `watch`**: build-only, skipped in dev.

> **Output location recommendation.** Lifecycle scripts executed by `exec` should write generated artifacts directly to your output directory (such as `dist/` or `dist/assets/`) rather than into source directories (`src/`). Writing generated files into `src/` can pollute your source tree with build artifacts and cause unnecessary `git` diffs or pre-push sync steps.

```ts
exec: [
  { script: 'scripts/generate-search-index.ts', watch: ['content/'] },
  { script: 'scripts/generate-llms-txt.ts' }, // build only
]
```

### `inlineStyles`

Controls which global stylesheets Bascik reads and injects as `<style>` tags into every page's `<head>` during transpilation. When `minify.css` is true the content is minified before injection. Global styles are placed before component styles so component rules take precedence.

- `false`: inline nothing
- `true`: inline every `.css` file under `directory.pages`
- `string[]`: inline only the listed stylesheet paths

```ts
inlineStyles: false // default
inlineStyles: true
inlineStyles: ['src/css/styles.css']
```

This eliminates the render-blocking `<link rel="stylesheet">` request, the CSS arrives in the same HTTP response as the HTML. It pairs naturally with `build` to minify only in production:

```ts
import { defineConfig } from '@bascik/bascik/config';

export default defineConfig({
  inlineStyles: ['src/css/styles.css'],
  minify: { css: false },
});

export const build = defineConfig({
  minify: { css: true },
});
```

> **When to inline.** Stylesheets under ~15 KB (gzipped) are good candidates. Larger stylesheets are better loaded asynchronously or split into critical and non-critical parts.

### `useWorkers`

Transpile pages across a pool of CPU-core worker threads instead of sequentially on the main thread.

```ts
useWorkers: false // default
useWorkers: true
```

Spinning up the worker pool has a fixed cost, each worker loads the transpiler's module graph independently, which takes roughly 15-250ms in total depending on machine and cache state (all workers load in parallel, so this is a one-time fixed delay, not a per-page cost). For small sites, or sites without slow per-page work, this fixed cost outweighs the benefit of spreading pages across cores, and sequential transpilation on the main thread finishes first.

> **When to enable.** Turn this on for larger sites (dozens of pages or more) doing CPU-heavy work per page, complex CSS/JS scoping across many components. It will not help much on sites whose slow parts are I/O-bound (e.g. `<script data-bascik-build>` blocks that fetch data or spawn subprocesses), since that work is already asynchronous regardless of which thread initiates it. Combine with `buildScriptCache: true` (the default) for the biggest speedup: workers handle parallel page transpilation while the cache eliminates redundant child-process spawns for unchanged scripts.

### `buildScriptCache`

Cache `<script data-bascik-build>` output on disk so unchanged scripts skip the Node.js child-process spawn on subsequent builds or server restarts.

```ts
buildScriptCache: true  // default
buildScriptCache: false // disable for debugging
```

Cache entries live in `node_modules/.cache/bascik/script-cache/`. The cache key covers the script content, dev/build mode, the current page path (`BASCIK_PAGE_FILE`), the site URL, and the content of any `content/*.md` or `scripts/*.{mjs,js,ts}` files the script references as quoted path literals. This means the cache self-invalidates on a per-script basis: editing one Markdown file only invalidates scripts that reference that file.

To bust the entire cache manually, for example after upgrading a build-time npm dependency whose output changed:

```sh
rm -rf node_modules/.cache/bascik/script-cache
```

Set to `false` when debugging a script that reads external state not covered by the cache key (e.g. a live API call or a file referenced by a dynamic path).

### `onScriptError`

Action to take when a `<script data-bascik-build>` or `<script data-bascik-server>` block fails to execute.

- `"warn"` (default in dev): Log a detailed warning to `console.warn` and continue transpilation, replacing the script tag's output with an empty string so the dev server stays running.
- `"error"` (default in `--build` and `--serve`): Log a detailed compilation error with line and column numbers to `console.error` and throw an exception to halt compilation.
- `"halt"`: Alias for `"error"`. Throws an exception and halts compilation immediately.

```ts
onScriptError: "warn" // default in dev; "error" in build/prod-server
```

### `onMinifyError`

Action to take when minification (HTML, CSS, or JS) fails due to invalid syntax or execution error.

- `"warn"` (default in dev): Log a warning to `console.warn` and proceed with unminified content so the dev server stays running.
- `"error"` (default in `--build` and `--serve`): Log a failure message to `console.error` and throw an exception to halt compilation immediately.
- `"halt"`: Alias for `"error"`. Throws an exception and halts compilation immediately.

```ts
onMinifyError: "warn" // default in dev; "error" in build/prod-server
```

## `build`

Exporting a `build` object lets you set options that apply during `bascik --build` and `bascik --serve` (production server), overriding the default export. A common pattern is to enable minification options only in production:

```ts
export const build = {
  minify: {
    html: true,
    css: true,
    js: true,
    identifiers: true,
  },
};
```
