/**
 * @module stored-page
 *
 * The shape of a compiled page in the in-memory page store (`mem.ts`).
 *
 * Kept out of `types.ts` on purpose: `@bascik/bascik/config` re-exports
 * every type in `types.ts`, and this one holds Node `Buffer`s, so a consumer
 * without `@types/node` would get TS2591 errors inside node_modules
 * (`public-types.integration.test.ts`).
 */

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
  serverScriptPlan?:
    import("./server-scripts.ts").ServerScriptPlan | { error: Error };
  /**
   * The component manifest the page was built against (prompt 157), kept by
   * reference from the publication that stored it, so a request renders the
   * component tags its server and stream scripts return with that version
   * and never a mix. Only pages with a plan carry one: a static page never
   * renders at request time.
   */
  componentManifest?: import("./component-manifest.ts").ComponentManifest;
  /** Pre-computed ETag from the page content buffer for fast response headers. */
  etag?: string;
}
