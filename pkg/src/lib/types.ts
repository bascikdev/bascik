// Central TypeScript types for the Bascik transpile pipeline

export interface ExecEntry {
  /** Path to the script (relative to project root). */
  script: string;
  /** File/directory globs that trigger a re-run in dev. Omit for build-only scripts. */
  watch?: string | string[];
}

export interface BascikComponent {
  name: string;
  /** Set during file loading; not required for in-test component objects */
  fileName?: string;
  fileContent: string;
  cssFileContent?: string;
  /** The full matched usage tag string from the page HTML, e.g. `<my-nav class="x">...</my-nav>` */
  content?: string;
  /** Inner HTML content from the usage site (slot content) */
  innerContent?: string;
  /** Position of the tag in the HTML string */
  index?: number;
}

export type ComponentList = Record<string, Omit<BascikComponent, "name">>;

export interface TranspileResult {
  transpiledHtmlBody: string;
  usedComponents: BascikComponent[];
}

export interface TranspilePageResult {
  relativePagePath: string;
  absolutePagePath: string;
  distHtml: string;
  usedComponentsNames: string[];
  fileDependencies?: string[];
}
export interface MinifyOptions {
  /**
   * Minify HTML output: strip comments and collapse excess whitespace.
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --serve`.
   */
  html: boolean;
  /**
   * Collapse whitespace and newlines in component `<style>` blocks, inline styles,
   * and static `.css` files.
   * Accepts `boolean` or a custom CSS minifier/transformer function.
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --serve`.
   *
   * ```ts
   * minify: {
   *   css: async (css) => (await transform(css, { minify: true })).code,
   * }
   * ```
   */
  css: boolean | ((code: string) => string | Promise<string>);
  /**
   * Minify inline `<script>` content and `.js` static files in the output.
   * Accepts `boolean` or a custom minifier function.
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --serve`.
   *
   * ```ts
   * minify: {
   *   js: async (js) => (await transform(js, { minify: true })).code,
   * }
   * ```
   */
  js: boolean | ((code: string) => string | Promise<string>);
  /**
   * Hash/shorten scoped attribute names (classes, ids, names) to short hex strings (e.g. `ba1b2c3d`) for compression.
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --serve`.
   */
  identifiers: boolean;
}

export interface BascikConfigOptions {
  scopeScriptBlocks: boolean;
  inheritAttributes: boolean;
  scopeAttribute: {
    class: boolean;
    id: boolean;
    name: boolean;
  };
  /**
   * When true (default), all instances of a component share the same scoped
   * class names so the compiled CSS is emitted only once per component type.
   * When false, each instance gets unique per-instance class names (the same
   * as `id` scoping) so JS class-selector queries naturally target only the
   * current instance, at the cost of one `<style>` block per instance.
   */
  deduplicateCss: boolean;
  directory: {
    pages: string;
    components: string;
  };
  /**
   * Extra directories or files to watch in dev mode. Any change inside these
   * paths triggers a full re-transpile of all pages, just like a component
   * change would. Has no effect during `bascik --build`.
   *
   * @example
   * watch: ['scripts/', 'data/']
   */
  watch: string[];
  /**
   * Options for HTML, CSS, and JS minification.
   */
  minify: MinifyOptions;
  cacheHttp: boolean;
  /**
   * Tag names whose inner content is left untouched by the scoping pipeline.
   * Attribute values, element-selector class injection, and JS selector
   * rewriting are all skipped inside these elements.
   * Defaults to ["code"].
   */
  skipTranspilingElementContents: string[];
  /**
   * Scripts to run as part of the build/dev lifecycle.
   *
   * Entries execute sequentially in array order before page transpilation.
   *
   * - `script`: path to the script (relative to project root), run with the
   *   same `node` binary that started bascik.
   * - `watch`: one or more directories/files to watch. When present, the
   *   script is run on dev startup (non-blocking) and re-run whenever a
   *   watched file changes (followed by a live-reload). Omit for build-only
   *   scripts that should not run during dev.
   *
   * @example
   * exec: [
   *   { script: 'scripts/generate-search-index.ts', watch: ['content/'] },
   *   { script: 'scripts/generate-llms-txt.ts' },
   * ]
   */
  exec?: ExecEntry[];
  /**
   * Control which files are generated in `dist/` during `bascik --build`.
   */
  generate: {
    /**
     * Write `dist/sitemap.xml` listing every HTML page as an absolute URL.
     * Requires `siteUrl` to be set. Defaults to `true`.
     */
    sitemap: boolean;
    /**
     * Write `dist/robots.txt` allowing all crawlers and pointing at the sitemap.
     * Defaults to `true`.
     */
    robots: boolean;
  };
  /**
   * The canonical base URL of the deployed site (e.g. `"https://example.com"`).
   * Required for sitemap generation. Trailing slash is trimmed automatically.
   */
  siteUrl?: string;
  /**
  * Stylesheets to inline into every page's `<head>` during transpilation.
  *
  * - `false` (default) — do not inline any global stylesheets.
  * - `true` — inline every `.css` file under `directory.pages`.
  * - `string[]` — inline only the listed stylesheet paths (relative to the
  *   project root).
  *
  * When `minify.css` is true the content is minified before injection.
  * Global styles are injected before component styles so component rules take
  * precedence.
   *
   * @example
   * inlineStyles: ['src/css/styles.css']
   */
  inlineStyles?: boolean | string[];
  /**
   * Transpile pages across a pool of CPU-core worker threads instead of
   * sequentially on the main thread. Defaults to `false`.
   *
   * Spinning up the pool has a fixed cost (loading the transpiler's module
   * graph into each worker thread, roughly 200-300ms total the first time,
   * in parallel across workers) before any page can be processed. For small
   * sites, or sites without expensive `<script data-bascik-build>` blocks,
   * this fixed cost outweighs the parallelism benefit and sequential
   * transpilation on the main thread is faster overall.
   *
   * Enable this for larger sites (dozens of pages) or sites with slow
   * per-page work (e.g. build scripts that fetch data or run markdown
   * rendering), where spreading pages across CPU cores pays for itself.
   *
   * @example
   * export const bascikConfig = { useWorkers: true };
   */
  useWorkers?: boolean;
  /**
   * Enable the persistent disk cache for `<script data-bascik-build>` output.
   * Cached results are stored in `node_modules/.cache/bascik/script-cache/`.
   * The cache key covers the script content, dev/build mode, the current page
   * path, the site URL, and the content of any `content/` or `scripts/` files
   * whose quoted path literals appear in the script — so the cache
   * self-invalidates when those tracked inputs change. Only files under those
   * directories with `.md`, `.mjs`, `.js`, or `.ts` extensions are detected;
   * other file reads are not tracked by the cache key.
   *
   * Defaults to `true`. Set to `false` to disable (e.g. when debugging a script
   * that reads external data not tracked by the cache key).
   *
   * To bust the entire cache manually:
   * `rm -rf node_modules/.cache/bascik/script-cache`
   *
   * @example
   * export const bascikConfig = { buildScriptCache: false };
   */
  buildScriptCache?: boolean;
  /**
   * Action to take when a `data-bascik-build` or `data-bascik-server` script
   * fails during execution.
   *
   * - `"warn"`  — Log a warning via `console.warn` and proceed, replacing the tag with an empty string.
   * - `"error"` — Log an error via `console.error` and throw an exception to halt compilation.
   * - `"halt"`  — Throw an error and halt compilation (alias for `"error"`).
   *
   * Defaults to `"warn"` during development (`bascik`) and `"error"` during build/prod-server (`bascik --build` / `bascik --serve`).
   */
  onScriptError?: "warn" | "error" | "halt";
  /**
   * Action to take when minification (HTML, CSS, or JS) fails due to invalid syntax or execution error.
   *
   * - `"warn"`  — Log a warning via `console.warn` and proceed with unminified content.
   * - `"error"` — Log an error via `console.error` and throw an exception to halt compilation.
   * - `"halt"`  — Throw an error and halt compilation (alias for `"error"`).
   *
   * Defaults to `"warn"` during development (`bascik`) and `"error"` during build/prod-server (`bascik --build` / `bascik --serve`).
   */
  onMinifyError?: "warn" | "error" | "halt";
  isBuild?: boolean;
  isProdServer?: boolean;
  /**
   * Development server logging controls. These are separate from the normal
   * `console.warn`/`console.error` diagnostics and only affect the high-traffic
   * "transpiled/copied/deleted" status lines that can get noisy during active
   * development.
   *
   * @example
   * export const bascikConfig = {
   *   devServer: {
   *     logging: {
   *       level: 'debug',
   *       copies: true,
   *       deletes: true,
   *       transpiles: true,
   *     },
   *   },
   * };
   */
  devServer?: {
    logging?: {
      /** `silent` | `error` | `warn` | `info` | `debug` */
      level?: "silent" | "error" | "warn" | "info" | "debug";
      /** Log HTTP requests served by the dev server. Defaults to `true`. */
      requests?: boolean;
      /** Log static-file copies into `dist/`. Defaults to `true`. */
      copies?: boolean;
      /** Log deletions from `dist/`. Defaults to `true`. */
      deletes?: boolean;
      /** Log page transpile events. Defaults to `true`. */
      transpiles?: boolean;
    };
  };
  /**
   * HTTP server configuration used for the production server (`bascik --serve`).
   *
   * @example
   * // bascik.config.ts
   * export const bascikConfig = {
   *   prodServer: {
   *     port: 443,
   *     hostname: '0.0.0.0',
   *     keyFile: '/etc/ssl/private/site.key',
   *     certFile: '/etc/ssl/certs/site.crt',
   *     logging: { level: 'warn', requests: false },
   *   },
   * };
   */
  prodServer?: {
    /** Port to listen on. Defaults to `8443`. */
    port?: number;
    /**
     * Hostname or IP to bind to. Use `"0.0.0.0"` to listen on all interfaces
     * (required when running in a container or behind a proxy). Defaults to
     * `"localhost"`.
     */
    hostname?: string;
    /** Path to a TLS private-key file (PEM). Auto-generated when omitted. */
    keyFile?: string;
    /** Path to a TLS certificate file (PEM). Auto-generated when omitted. */
    certFile?: string;
    /** Enable TLS (HTTPS) and serve over HTTP/2. Defaults to `false` (plain HTTP/1.1 is default). */
    enableTls?: boolean;
    /**
     * Enable per-IP rate limiting (500 requests per 10s window) on the production server.
     * Defaults to `true`. Set to `false` to disable rate limiting in `--serve` mode.
     */
    rateLimit?: boolean;
    /**
     * Maximum execution time (ms) for each `data-bascik-server` child process.
     * Scripts that exceed this deadline are killed and their output is dropped.
     * Defaults to `30000` (30 s).
     */
    scriptTimeout?: number;
    logging?: {
      /** `silent` | `error` | `warn` | `info` | `debug` */
      level?: "silent" | "error" | "warn" | "info" | "debug";
      /** Log HTTP requests served by the production server. Defaults to `true`. */
      requests?: boolean;
    };
  };
}

export interface StoredPage {
  relativePagePath: string;
  absolutePagePath: string;
  content: Buffer;
  // Computed asynchronously in the background; undefined until brotli
  // compression finishes, in which case the server serves uncompressed.
  compressedContent: Buffer | undefined;
  usedComponentsSet: Set<string>;
  /** Relative paths of local file dependencies referenced by build scripts on this page. */
  fileDependenciesSet?: Set<string>;
  /** True when the stored HTML contains `data-bascik-server` script blocks. */
  hasServerScripts: boolean;
}
