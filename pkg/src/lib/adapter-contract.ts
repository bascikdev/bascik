/**
 * @module adapter-contract
 *
 * Hosting adapter contract and types for Bascik serverless targets (prompt 142).
 */

import type {
  ContentSecurityPolicyConfig,
  CspRouteHashes,
} from "./content-security-policy.ts";
import type { ResponseSecurity } from "./web-response.ts";
import type { RenderLimitsOptions } from "./types.ts";

export interface SiteGraphJob {
  id: string;
  mode: "server" | "stream";
  source:
    | { kind: "module"; path: string }
    | { kind: "inline"; code: string; stagedPath: string };
  owner: string; // authored location for diagnostics
  /**
   * The component's element classes for this job's output (prompt 157):
   * set on a component's server or stream script, whether placed on a page
   * statically or named by the manifest. A host applies it with
   * `applyOutputScope(output, decodeOutputScope(outputScope))`, as Node does.
   */
  outputScope?: string;
}

export interface DistPageSegment {
  kind: "static" | "script";
  text?: string;
  id?: string;
}

export interface SiteGraphPage {
  path: string;
  is404: boolean;
  segments: DistPageSegment[];
  jobs: Record<string, SiteGraphJob>;
}

export interface SiteGraphApiRoute {
  path: string;
  filePath: string;
  paramNames: string[];
  isDynamic: boolean;
}

/**
 * The request-time component section of a site graph (prompt 157): the
 * build's manifest and the component scripts it names, keyed by job id. An
 * adapter renders component tags in script output through
 * `@bascik/bascik/runtime`'s `wrapRunner` with these; the jobs live here, not
 * on a page, since any page's script may return any component.
 */
export interface SiteGraphComponents {
  manifest: import("./component-manifest.ts").ComponentManifest;
  jobs: Record<string, SiteGraphJob>;
}

export interface SiteGraph {
  base: string;
  release: string;
  scriptTimeoutMs: number;
  apiTimeoutMs: number;
  onServerScriptError: "error" | "warn" | "ignore";
  publicFiles: string[]; // dist-relative, already filtered
  pages: Record<string, SiteGraphPage>; // dynamic pages by canonical path
  apiRoutes: SiteGraphApiRoute[]; // sorted, with absolute filePath
  custom500?: string;
  importRoot: string; // absolute; for adapters that bundle
  /** Present exactly when the build wrote .bascik/dist/components.json (sites with server or stream scripts). */
  components?: SiteGraphComponents;
  /**
   * Present exactly when `contentSecurityPolicy` is set: the policy, each
   * route's build hashes (csp-hashes.json, widened for request-time
   * components), and the HTTP paths of the static pages, which a host that
   * serves them without the runtime must cover another way.
   */
  contentSecurityPolicy?: SiteGraphContentSecurityPolicy;
  /**
   * `security.headers`, `security.hsts` and `security.privateDynamicPages`
   * from the build, resolved (`resolveResponseSecurity`). Pass it as the
   * `security` option of the runtime's response builders. Absent: defaults.
   */
  responseSecurity?: ResponseSecurity;
  /** `security.hideDotfiles` from the build; pass to `isPrivatePathname`. Absent: true. */
  hideDotfiles?: boolean;
  /** `scripts.stripAnsi` from the build. Absent: true. */
  stripAnsi?: boolean;
  /** `scripts.renderLimits` from the build, every field set. Pass as `RenderHost.limits`. Absent: defaults. */
  renderLimits?: RenderLimitsOptions;
}

export interface SiteGraphContentSecurityPolicy {
  policy: ContentSecurityPolicyConfig;
  hashes: Record<string, CspRouteHashes>;
  staticRoutes: string[];
}

export interface AdapterBuildContext {
  graph: SiteGraph;
  distDir: string; // read-only for the adapter
  outDir: string; // dist/.bascik/<target>/, adapter writes here only
  projectRoot: string;
  variant?: string; // from the official-name map
  log: (message: string) => void;
  /** Portable runtime entry the adapter bundles: resolved file path of `@bascik/bascik/runtime`. */
  runtimeEntry: string;
}

export interface AdapterBuildResult {
  workerPath?: string;
  publicDir: string;
  bundleBytes?: number;
  notes?: string[];
  /**
   * `true` when the adapter's runtime renders `graph.components` (prompt
   * 157). Without it, the core warns at build time that component tags in
   * script output will reach clients unexpanded on this host.
   */
  components?: boolean;
}

export interface HostingAdapter {
  name: string;
  build(context: AdapterBuildContext): Promise<AdapterBuildResult>;
}

export const defineAdapter = (adapter: HostingAdapter): HostingAdapter =>
  adapter;
