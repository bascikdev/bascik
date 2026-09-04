// Central TypeScript types for the Bascik transpile pipeline
//
// Config naming: three concepts, three names.
//   UserConfig          — the user-facing input type written in bascik.config (see defineConfig.ts)
//   BascikConfigOptions — the resolved runtime type after defaults and mode overrides are merged
//   BascikConfig        — the frozen runtime value exported from config.ts

export type ExecPhase = "pre" | "post" | "parallel";

export interface ExecEntry {
  /** Path to the script (relative to project root). */
  script: string;
  /** File/directory globs that trigger a re-run in dev. Omit for build-only scripts. */
  watch?: string | string[];
  /**
   * When this script runs relative to page transpilation.
   * - 'pre' (default): awaited before any page is transpiled, in dev and build alike.
   * - 'post': runs after all pages are transpiled and written to dist.
   * - 'parallel': started before transpilation and joined before transpilation begins in build mode.
   */
  phase?: ExecPhase;
  /** Working directory for the script execution. Defaults to process.cwd(). */
  cwd?: string;
  /** Environment variables passed to the script, merged with process.env. */
  env?: Record<string, string>;
  /** Command line arguments passed to the Node script (process.argv). */
  args?: string[];
  /** Execution timeout in milliseconds (default: 60,000ms). */
  timeout?: number;
}

export interface RouteParams {
  [key: string]: string | number;
}

export interface RouteEntry {
  params: Record<string, string | number>;
  data?: unknown;
}

export interface BascikComponent {
  name: string;
  /** Set during file loading; not required for in-test component objects */
  fileName?: string;
  fileContent: string;
  /** Preserved raw HTML before build script execution for dependency extraction */
  scriptDependenciesContent?: string;
  cssFileContent?: string;
  /** The full matched usage tag string from the page HTML, e.g. `<my-nav class="x">...</my-nav>` */
  content?: string;
  /** Inner HTML content from the usage site (slot content) */
  innerContent?: string;
  /** Position of the tag in the HTML string */
  index?: number;
  /** Internal original-to-scoped ID map shared with later CSS processing. */
  scopedIdNames?: Record<string, string>;
  /** Internal flag for component instances whose CSS references per-instance IDs. */
  requiresPerInstanceCss?: boolean;
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
  serverScripts?: Record<string, {
    id: string;
    mode: "server" | "stream";
    source: string;
    modulePath?: string;
    sourceFile?: string;
    sourceLine?: number;
  }>;
}
export interface MinifyOptions {
  /**
   * Minify HTML output: strip comments and collapse excess whitespace.
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --server`.
   */
  html: boolean;
  /**
   * Collapse whitespace and newlines in component `<style>` blocks, inline styles,
   * and static `.css` files.
   * Accepts `boolean` or a custom CSS minifier/transformer function.
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --server`.
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
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --server`.
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
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --server`.
   */
  identifiers: boolean;
}

export interface DirectoryOptions {
  pages: string;
  /**
   * Every configured components root, resolved to an absolute path (realpath
   * when the directory exists), deduplicated, in author order. Normalized once
   * in `config.ts`; consumers never re-check for a single string. Roots may sit
   * outside the project root (monorepo shared components).
   */
  components: string[];
  out: string;
  api: string;
}

/** User-facing `directory` shape: `components` accepts one path or many. */
export interface DirectoryInput {
  pages?: string;
  components?: string | string[];
  out?: string;
  api?: string;
}

export interface ScopingAttributesOptions {
  class: boolean;
  id: boolean;
  name: boolean;
}

export interface ScopingOptions {
  scriptBlocks: boolean;
  inheritAttributes: boolean;
  attributes: ScopingAttributesOptions;
  preserve: string[];
  deduplicateCss: boolean;
}

export interface AssetsOptions {
  inlineStyles: boolean | string[];
  exclude: string[];
}

export interface GenerateOptions {
  sitemap: boolean;
  robots: boolean;
  sitemapLastmod: boolean;
  cspHashes: boolean;
  manifest: boolean;
}

export interface PipelineOptions {
  watchPaths: string[];
  exec?: ExecEntry[];
  workers: boolean;
}

export interface ScopableOptions {
  enabled: boolean;
  include?: string[];
  exclude?: string[];
}

export type ScopableConfig = boolean | {
  enabled?: boolean;
  include?: string[];
  exclude?: string[];
};

export interface ScriptsOptions {
  cache: ScopableOptions;
  onBuildScriptError: "warn" | "error";
  onRoutesScriptError: "warn" | "error";
  onServerScriptError: "warn" | "error";
  timeout: number;
  /**
   * Directory that `@/` import specifiers (and script tag `src=` values)
   * resolve against inside build, server, and routes scripts. A bare leading
   * `/` is not an alias and is rejected with an error.
   * Relative to the project root; kept as written and resolved at use sites.
   * Independent of `directory.pages` and `directory.components`; may point
   * outside the project (for example `../shared/scripts` in a monorepo).
   * Default `"src"`.
   */
  importRoot: string;
}

export interface HttpTlsOptions {
  enabled: boolean;
  keyFile?: string;
  certFile?: string;
}

export interface HttpTimeoutsOptions {
  request?: number;
  headers?: number;
  keepAlive?: number;
  drain?: number;
}

export interface HttpOptions {
  httpCache: boolean;
  /** TCP port to listen on. Defaults to `8080` for HTTP, or `8443` when TLS is enabled. */
  port?: number;
  hostname: string;
  tls: HttpTlsOptions;
  rateLimit: boolean | { window?: number; max?: number };
  trustProxy: boolean;
  cacheControl: string | Record<string, string>;
  compression: boolean;
  timeouts?: HttpTimeoutsOptions;
  maxBodySize: number;
  apiTimeout: number;
}

export interface LoggingOptions {
  level: "silent" | "error" | "warn" | "info" | "debug";
  requests: boolean;
  copies: boolean;
  deletes: boolean;
  transpiles: boolean;
}

export interface BascikConfigOptions {
  directory: DirectoryOptions;
  scoping: ScopingOptions;
  minify: MinifyOptions;
  assets: AssetsOptions;
  generate: GenerateOptions;
  pipeline: PipelineOptions;
  scripts: ScriptsOptions;
  onMinifyError: "warn" | "error";
  http: HttpOptions;
  logging: LoggingOptions;
  base: string;
  isBuild: boolean;
  isProdServer: boolean;
  only?: string[];
}

export type UserConfig = {
  directory?: DirectoryInput;
  scoping?: {
    scriptBlocks?: boolean;
    inheritAttributes?: boolean;
    attributes?: Partial<ScopingAttributesOptions>;
    preserve?: string[];
    deduplicateCss?: boolean;
  };
  minify?: boolean | Partial<MinifyOptions>;
  assets?: {
    inlineStyles?: boolean | string[];
    exclude?: string[];
  };
  generate?: Partial<GenerateOptions>;
  pipeline?: {
    watchPaths?: string[];
    exec?: ExecEntry[];
    workers?: boolean;
  };
  scripts?: {
    cache?: ScopableConfig;
    onBuildScriptError?: "error" | "warn" | "ignore";
    onRoutesScriptError?: "error" | "warn" | "ignore";
    onServerScriptError?: "error" | "warn" | "ignore";
    timeout?: number;
    importRoot?: string;
  };
  onMinifyError?: "warn" | "error";
  http?: {
    httpCache?: boolean;
    /** TCP port to listen on. Defaults to `8080` for HTTP, or `8443` when TLS is enabled. */
    port?: number;
    hostname?: string;
    tls?: Partial<HttpTlsOptions>;
    rateLimit?: boolean | { window?: number; max?: number };
    trustProxy?: boolean;
    cacheControl?: string;
    compression?: boolean;
    timeouts?: HttpTimeoutsOptions;
    maxBodySize?: number;
    apiTimeout?: number;
  };
  logging?: Partial<LoggingOptions>;
  base?: string;
};

export interface StoredPage {
  relativePagePath: string;
  absolutePagePath: string;
  content: Buffer;
  // Computed asynchronously in the background; undefined until brotli
  // compression finishes, in which case the server falls back to gzip
  // (if ready) or identity.
  compressedContent: Buffer | undefined;
  /**
   * Gzip fallback for clients whose Accept-Encoding lacks `br` (legacy
   * browsers, some proxies and crawlers). Computed in the background after
   * store like `compressedContent`; undefined until ready.
   */
  gzipContent?: Buffer;
  usedComponentsSet: Set<string>;
  /** Relative paths of local file dependencies referenced by build scripts on this page. */
  fileDependenciesSet?: Set<string>;
  /**
   * Precomputed at store time (prompt 67). `undefined` when the page has no
   * `data-bascik-server` / `data-bascik-stream` blocks; the server then takes
   * the static/ETag/Brotli path. When defined, the server never rescans
   * `content` and uses the plan's segments directly. A planner error
   * (conflicting directives, unresolvable sidecar id) is stored as `{ error }`
   * so one bad page yields a 500 for that page only and never blocks the rest
   * of the site from loading.
   */
  serverScriptPlan?: import("./server-scripts.ts").ServerScriptPlan | { error: Error };
  /** Pre-computed ETag from the page content buffer for fast response headers. */
  etag?: string;
}
