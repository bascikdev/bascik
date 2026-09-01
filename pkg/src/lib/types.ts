// Central TypeScript types for the Bascik transpile pipeline

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
   * - 'parallel': started before transpilation but not awaited (fire-and-forget).
   */
  phase?: ExecPhase;
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
   * Defaults to `false` in dev mode and `true` during `bascik --build` and `bascik --server`.
   */
  identifiers: boolean;
}

export interface DirectoryOptions {
  pages: string;
  components: string;
  out: string;
  public?: string;
  api: string;
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
}

export interface HttpOptions {
  httpCache: boolean;
  port?: number;
  hostname: string;
  tls: HttpTlsOptions;
  rateLimit: boolean | { window?: number; max?: number };
  trustProxy: boolean;
  cacheControl: string;
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
}

export type UserConfig = {
  directory?: Partial<DirectoryOptions>;
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
  };
  onMinifyError?: "warn" | "error";
  http?: {
    httpCache?: boolean;
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
  // compression finishes, in which case the server serves uncompressed.
  compressedContent: Buffer | undefined;
  usedComponentsSet: Set<string>;
  /** Relative paths of local file dependencies referenced by build scripts on this page. */
  fileDependenciesSet?: Set<string>;
  /** True when the stored HTML contains `data-bascik-server` script blocks. */
  hasServerScripts: boolean;
  /** Pre-computed ETag from the page content buffer for fast response headers. */
  etag?: string;
}
