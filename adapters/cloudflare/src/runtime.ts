/**
 * @module adapters/cloudflare-runtime
 *
 * The request handler that runs inside a Cloudflare Worker (prompt 134).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Portable: no Node imports (the request-time component host,
 * component-host.ts, uses `node:crypto` under `nodejs_compat` and is bundled
 * only for sites with components, prompt 157). It is bundled into the
 * generated `_worker.js` together with the site graph emitted by
 * `serverless-artifacts.ts`, and it drives the same execution core the Node
 * server uses (`lib/request-execution.ts`).
 *
 * Request flow inside the Worker:
 *
 *   fetch(request, env, ctx)
 *     ├─ unsafe or hidden path                -> 400 / 404
 *     ├─ outside `base`                       -> 404
 *     ├─ API route match                      -> dispatchApiHandler(...)
 *     ├─ dynamic page alias match             -> compose from private template
 *     │     ├─ no stream jobs or HEAD         -> buffered body, content-length
 *     │     └─ stream jobs                    -> Response(ReadableStream) before body completes
 *     └─ anything else                        -> env.ASSETS.fetch(request)
 *
 * Every dynamic page template lives in the private graph, never in the public
 * asset tree, so a routing failure that lets a request fall through to assets
 * yields a 404, not an inert-placeholder document.
 *
 * Bindings and execution context reach handlers as `context.platform`
 * (`{ name: "cloudflare", env, waitUntil }`). Nothing is copied onto globals
 * and `process.env` is never touched.
 */

import { componentExecution } from "./component-host.js";
import {
  applyOutputScope,
  decodeOutputScope,
  composeBufferedResponse,
  dispatchApiHandler,
  invokeLoadedWithDeadline,
  scriptTimeoutError,
  streamComposedResponse,
  type ApiHandlerContext,
  type ApiHandlerModule,
  type ExecutionPlan,
  type ExecutionSegment,
  type PlatformContext,
  type RenderHost,
  type ScriptJobRunner,
  dynamicPageHeaders,
  errorResponse,
  internalErrorPage,
  mergeHandlerHeaders,
  stripRepresentationHeaders,
  GENERATED_CONTROL_PATHS,
  isPrivatePathname,
  isUnsafePathname,
  InvalidApiPathError,
  matchApiRoute,
  pageLookupCandidates,
  stripAnsiEscapeCodes,
  contentSecurityPolicyHeader,
  DEFAULT_RESPONSE_SECURITY,
  type ApiRouteDefinition,
  type ContentSecurityPolicyConfig,
  type CspRouteHashes,
  type RequestRenderLimits,
  type ResponseSecurity,
} from "@bascik/bascik/runtime";

/**
 * A job's output with its component's element classes applied, when the job
 * carries an output scope, as `runServerScriptJob` does on Node. It lives
 * here, not in component-host.ts, because page jobs carry a scope too (that
 * of a component placed statically on the page) whether or not the manifest
 * has anything renderable: a Worker built with the component-host stub must
 * still scope them. Both helpers are portable (no `node:crypto`).
 */
const scopeJobOutput = (job: GraphScriptJob, output: string): string => {
  const scope = decodeOutputScope(job.outputScope);
  return scope ? applyOutputScope(output, scope) : output;
};

// ─── Site graph contract (emitted by serverless-artifacts.ts) ────────────────

/** A request-time script job inside a dynamic page template. */
export interface GraphScriptJob {
  id: string;
  mode: "server" | "stream";
  /**
   * The component's element classes for this job's output (prompt 157):
   * set on component scripts, and on a page job a component placed
   * statically, so their returned markup is styled like the component's own.
   */
  outputScope?: string;
  /**
   * Where a component script is authored (`server script in
   * src/components/x.html:12`), set on component jobs (prompt 157): the
   * bundled stack names only the Worker file, so a failure is located from
   * this instead.
   */
  owner?: string;
  /** Loader for the compiled module; `default` is the handler. */
  load: () => Promise<{ default: unknown }>;
}

/** The build's component manifest, as the portable renderer reads it. */
export type ComponentManifest = NonNullable<RenderHost["manifest"]>;

/**
 * Request-time components (prompt 157): the manifest, emitted by build.ts
 * only when it lists a component, and the component scripts it names, keyed
 * by job id. They belong to no page: any page's script may return any
 * component.
 */
export interface GraphComponents {
  manifest: ComponentManifest;
  jobs: Record<string, GraphScriptJob>;
}

export interface GraphPageSegment {
  kind: "static" | "script";
  /** UTF-8 text for static segments. */
  text?: string;
  /** Job id for script segments. */
  id?: string;
}

export interface GraphPage {
  /** Canonical HTTP path (`/`, `/blog/`, `/about`). */
  path: string;
  /** Whether this page is the authored 404 page. */
  is404: boolean;
  segments: GraphPageSegment[];
  jobs: Record<string, GraphScriptJob>;
}

export interface GraphApiRoute extends ApiRouteDefinition {
  load: () => Promise<ApiHandlerModule>;
}

export interface SiteGraph {
  /** Normalized base path, always starting and ending with `/`. */
  base: string;
  /** Script deadline for server/stream jobs, ms. */
  scriptTimeoutMs: number;
  /** Deadline for API handlers, ms. */
  apiTimeoutMs: number;
  /** `scripts.onServerScriptError` at build time. */
  onServerScriptError: "error" | "warn" | "ignore";
  /** Dynamic pages by canonical path. */
  pages: Record<string, GraphPage>;
  /** Sorted API routes (static, then `[param]`, then catch-all). */
  apiRoutes: GraphApiRoute[];
  /** Optional authored 500 page body. */
  custom500?: string;
  /** A static `404.html` is deployed; its own URLs answer 404, as on Node. */
  staticNotFoundPage?: boolean;
  /** Release identity for diagnostics headers. */
  release: string;
  /** Present when the site renders component tags in script output. */
  components?: GraphComponents;
  /**
   * Opt-in `contentSecurityPolicy`: the policy and the build hashes of each
   * page the Worker renders (static pages carry theirs in _headers).
   */
  contentSecurityPolicy?: {
    policy: ContentSecurityPolicyConfig;
    hashes: Record<string, CspRouteHashes>;
  };
  /**
   * The build's `security.headers`, `security.hsts` and
   * `security.privateDynamicPages`, resolved. Absent: the defaults.
   */
  responseSecurity?: ResponseSecurity;
  /**
   * Set when the Worker runs before every static file (`run_worker_first:
   * true` in the authored wrangler config): the build writes no `_headers`
   * rules, and the Worker adds the security headers, and each listed static
   * page's CSP, to what the asset layer returns. A header the response
   * already has (from the author's own `_headers`) is kept.
   */
  assetHeaders?: {
    /** Static pages (paths without the base) whose CSP the Worker sends. */
    cspRoutes: string[];
  };
  /** The build's `security.hideDotfiles`. Absent: true. */
  hideDotfiles?: boolean;
  /** The build's `scripts.stripAnsi`. Absent: true. */
  stripAnsi?: boolean;
  /** The build's `scripts.renderLimits`. Absent: the defaults. */
  renderLimits?: Partial<RequestRenderLimits>;
}

// ─── Cloudflare runtime types (subset, kept local to avoid a type dependency) ─

export interface CloudflareAssetsBinding {
  fetch(request: Request): Promise<Response>;
}

export interface CloudflareEnv {
  ASSETS?: CloudflareAssetsBinding;
  [binding: string]: unknown;
}

export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

export interface CloudflareWorker {
  fetch(
    request: Request,
    env: CloudflareEnv,
    ctx: CloudflareExecutionContext,
  ): Promise<Response>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

const CONTROL_PATHS: ReadonlySet<string> = new Set(GENERATED_CONTROL_PATHS);

/** `stripBasePath` from `lib/base-path.ts`, inlined to keep this graph free of the shielding import. */
export const stripBase = (pathname: string, base: string): string | null => {
  if (base === "/") return pathname;
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  if (pathname === prefix) return "/";
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length);
};

/** Derive the client IP from Cloudflare's trusted header; never from X-Forwarded-For. */
export const cloudflareRemoteIp = (request: Request): string =>
  request.headers.get("cf-connecting-ip") ?? "";

const isHttps = (request: Request): boolean =>
  new URL(request.url).protocol === "https:";

const toExecutionPlan = (page: GraphPage): ExecutionPlan => {
  const segments: ExecutionSegment[] = page.segments.map((segment) =>
    segment.kind === "static"
      ? { kind: "static", bytes: encoder.encode(segment.text ?? "") }
      : { kind: "script", mode: page.jobs[segment.id!].mode, id: segment.id! },
  );
  return {
    segments,
    firstStreamIndex: segments.findIndex(
      (s) => s.kind === "script" && s.mode === "stream",
    ),
  };
};

const findPage = (
  graph: SiteGraph,
  pathname: string,
): GraphPage | undefined => {
  for (const candidate of pageLookupCandidates(pathname)) {
    const page = graph.pages[candidate];
    if (page) return page;
  }
  return undefined;
};

const missingJob = (id: string): Error =>
  new Error(
    `[bascik] server script job "${id}" is missing from the deployment graph.`,
  );

/**
 * Run one graph job under `timeoutMs`. Output handling mirrors
 * `runServerScriptJob`: a string or stringifiable value is the fragment,
 * stripped of ANSI escapes, and a job carrying an output scope (a
 * component's script, prompt 157) gets the component's element classes
 * applied; a failing job with an owner is located by it; failure under
 * `onServerScriptError: "error"` throws (500 before commit, empty after),
 * `warn` logs and yields empty, `ignore` yields empty.
 */
const runGraphJob = async (
  job: GraphScriptJob,
  id: string,
  graph: SiteGraph,
  request: Request,
  context: { remoteIp: string; platform: PlatformContext },
  log: (message: string) => void,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<string> => {
  // The load and the handler run under one deadline, and the handler's own
  // promise is settled by the shared rule: once the deadline fires or the
  // client aborts, that is the outcome, exactly as on Node. Calling the
  // handler directly (not from an async wrapper) keeps a value settled just
  // before the deadline from being mistaken for a timeout.
  const result = await invokeLoadedWithDeadline(
    () => job.load(),
    (mod, { signal: jobSignal }) => {
      const handler = mod.default;
      if (typeof handler !== "function") {
        throw new TypeError(
          `Server script "${id}" does not export a default function.`,
        );
      }
      return handler(request, context, { signal: jobSignal });
    },
    // Node's message, so a log reads the same on both hosts.
    { timeoutMs, signal, timeoutError: scriptTimeoutError },
  );
  if (result.ok) {
    const value = result.value;
    const output =
      typeof value === "string"
        ? value
        : value !== undefined && value !== null
          ? String(value)
          : "";
    // scripts.stripAnsi off: the codes reach the page as printed.
    return scopeJobOutput(
      job,
      graph.stripAnsi === false ? output : stripAnsiEscapeCodes(output),
    );
  }
  if (result.aborted && !result.timedOut) return "";
  const error = result.error ?? new Error("Server script failed");
  // Node maps the stack to the authored file; here it names only the bundle,
  // so a component job (a timeout, a throw or a missing default export deep
  // inside a rendered tag) is placed by the owner the build recorded.
  const where = job.owner ? `\n    in the ${job.owner}` : "";
  const message = `[bascik] server script error at "${new URL(request.url).pathname}":\n${error.stack ?? error.message}${where}`;
  if (graph.onServerScriptError === "error") throw new Error(message);
  if (graph.onServerScriptError === "warn") log(message);
  return "";
};

/**
 * Build a `ScriptJobRunner` for one request: the page's own jobs, then the
 * component scripts of `graph.components` (prompt 157), under the graph's
 * script deadline and error policy (see `runGraphJob`).
 */
export const createGraphJobRunner = (
  page: GraphPage,
  graph: SiteGraph,
  request: Request,
  context: { remoteIp: string; platform: PlatformContext },
  log: (message: string) => void,
): ScriptJobRunner => {
  return async (id, signal) => {
    const job = page.jobs[id] ?? graph.components?.jobs[id];
    if (!job) throw missingJob(id);
    return runGraphJob(
      job,
      id,
      graph,
      request,
      context,
      log,
      signal,
      graph.scriptTimeoutMs,
    );
  };
};

/**
 * The page's plan and runner for one request. With a component manifest
 * that has something to render (prompt 157), the runner is wrapped so
 * component tags in job output are rendered (component-host.ts), and the
 * component scripts run like page jobs with the parent's remaining budget.
 * Without one, plan and runner are exactly what they always were.
 */
export const createPageExecution = (
  page: GraphPage,
  graph: SiteGraph,
  request: Request,
  context: { remoteIp: string; platform: PlatformContext },
  log: (message: string) => void,
): { plan: ExecutionPlan; run: ScriptJobRunner } => {
  const run = createGraphJobRunner(page, graph, request, context, log);
  const components = graph.components;
  const rendered = components
    ? componentExecution(
        page,
        graph,
        request,
        run,
        (id, signal, budgetMs) => {
          const job = components.jobs[id];
          if (!job) return Promise.reject(missingJob(id));
          return runGraphJob(
            job,
            id,
            graph,
            request,
            context,
            log,
            signal,
            budgetMs,
          );
        },
        log,
      )
    : null;
  return rendered ?? { plan: toExecutionPlan(page), run };
};

export interface CreateWorkerOptions {
  /** Diagnostics sink; defaults to `console.error`. Never reaches the client. */
  log?: (message: string) => void;
}

/**
 * Build the Module Worker `fetch` handler for a site graph. The returned
 * object is what `_worker.js` exports as `default`.
 */
export const createCloudflareWorker = (
  graph: SiteGraph,
  options: CreateWorkerOptions = {},
): CloudflareWorker => {
  const log = options.log ?? ((message: string) => console.error(message));
  // The build's response security (absent: every default); passed to every
  // response builder so pages, API responses and errors agree with Node.
  const security = graph.responseSecurity;
  const hideDotfiles = graph.hideDotfiles !== false;
  const assetCspRoutes = new Set(graph.assetHeaders?.cspRoutes ?? []);

  /** The opt-in CSP header, from the build's hashes for this page (never its body). */
  const setPageCsp = (headers: Headers, path: string): void => {
    const csp = graph.contentSecurityPolicy;
    if (!csp) return;
    const { name, value } = contentSecurityPolicyHeader(
      csp.policy,
      csp.hashes[path],
    );
    headers.set(name, value);
  };

  const forwardToAssets = async (
    request: Request,
    env: CloudflareEnv,
  ): Promise<Response> => {
    if (!env.ASSETS) {
      log(
        "[bascik] ASSETS binding is missing: static requests cannot be served.",
      );
      return errorResponse(500, "Internal Server Error", {
        https: isHttps(request),
        security,
      });
    }
    const response = await env.ASSETS.fetch(request);
    return graph.assetHeaders ? withAssetHeaders(request, response) : response;
  };

  /** The listed static 404 page nearest to `path`, as the asset layer looks one up. */
  const notFoundRouteFor = (path: string): string | undefined => {
    const segments = path.split("/").slice(1, -1);
    for (let depth = segments.length; depth >= 0; depth--) {
      const dir = segments.slice(0, depth).join("/");
      const route = dir ? `/${dir}/404` : "/404";
      if (assetCspRoutes.has(route)) return route;
    }
    return undefined;
  };

  /** The headers _headers would have given a static file, sent by the Worker instead. */
  const withAssetHeaders = (request: Request, response: Response): Response => {
    const headers = new Headers(response.headers);
    const resolved = security ?? DEFAULT_RESPONSE_SECURITY;
    for (const [name, value] of Object.entries(resolved.headers))
      if (!headers.has(name)) headers.set(name, value);
    if (
      isHttps(request) &&
      resolved.hsts !== null &&
      !headers.has("strict-transport-security")
    )
      headers.set("strict-transport-security", resolved.hsts);
    const csp = graph.contentSecurityPolicy;
    let path: string | null = null;
    try {
      path = stripBase(
        decodeURIComponent(new URL(request.url).pathname),
        graph.base,
      );
    } catch {
      path = null;
    }
    // A miss answered with a 404.html carries that page's policy, as the
    // Node server sends the 404 page's own: the asset layer serves the
    // nearest 404.html up the path (`/docs/nope` gets `/docs/404.html`).
    const route =
      path === null
        ? undefined
        : assetCspRoutes.has(path)
          ? path
          : response.status === 404
            ? notFoundRouteFor(path)
            : undefined;
    if (csp && route !== undefined) {
      const { name, value } = contentSecurityPolicyHeader(
        csp.policy,
        csp.hashes[route],
      );
      if (!headers.has(name)) headers.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };

  const fetchHandler = async (
    request: Request,
    env: CloudflareEnv,
    ctx: CloudflareExecutionContext,
  ): Promise<Response> => {
    const https = isHttps(request);
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return errorResponse(400, "Bad Request", { https, security });
    }
    if (isUnsafePathname(pathname))
      return errorResponse(400, "Bad Request", { https, security });
    // Same rule as the Node server: dot segments are private except a leading
    // RFC 8615 /.well-known/ below the site root, which the asset layer serves
    // (with security.hideDotfiles off, only a first `.bascik` segment is).
    if (isPrivatePathname(pathname, graph.base, hideDotfiles))
      return errorResponse(404, "Not Found", { https, security });

    const baseRelative = stripBase(pathname, graph.base);
    if (baseRelative === null)
      return errorResponse(404, "Not Found", { https, security });
    // The bundle and its routing table are deployment control files, never
    // content. Refusing them here makes the guarantee independent of how a
    // host treats underscore-prefixed uploads.
    if (CONTROL_PATHS.has(baseRelative))
      return errorResponse(404, "Not Found", { https, security });

    const platform: PlatformContext = {
      name: "cloudflare",
      env,
      waitUntil: (promise) => ctx.waitUntil(promise),
    };
    const remoteIp = cloudflareRemoteIp(request);

    // ── API routes (before the method guard so every method reaches them) ──
    let apiMatch: ReturnType<typeof matchApiRoute<GraphApiRoute>>;
    try {
      // Catch-all routes split and decode the raw path themselves, so an
      // encoded separator cannot forge a segment boundary.
      apiMatch = matchApiRoute(graph.apiRoutes, pathname, url.pathname);
    } catch (err) {
      if (!(err instanceof InvalidApiPathError)) throw err;
      return errorResponse(400, "Bad Request", { https, security });
    }
    if (apiMatch) {
      const route = apiMatch.route as GraphApiRoute;
      let mod: ApiHandlerModule;
      try {
        mod = await route.load();
      } catch (err) {
        log(
          `[bascik] Failed to load API route module ${route.filePath}: ${(err as Error).stack ?? String(err)}`,
        );
        return errorResponse(500, "Internal Server Error", { https, security });
      }
      const context: ApiHandlerContext = {
        params: apiMatch.params,
        remoteIp,
        platform,
      };
      const response = await dispatchApiHandler(mod, request, context, {
        timeoutMs: graph.apiTimeoutMs,
        signal: request.signal,
        onError: (message, error) =>
          log(
            `[bascik] ${message}${error ? `\n${(error as Error).stack ?? String(error)}` : ""}`,
          ),
      });
      const headers = mergeHandlerHeaders(response.headers, {
        https,
        security,
      });
      // A HEAD answer sends no body: release the one an explicit HEAD
      // handler returned (a derived HEAD's GET body is released by the core).
      if (request.method === "HEAD" && response.body && !response.body.locked)
        response.body.cancel().catch(() => {});
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // ── Dynamic pages ─────────────────────────────────────────────────────
    const page = findPage(graph, baseRelative);
    if (!page) {
      if (
        graph.staticNotFoundPage &&
        pageLookupCandidates(baseRelative).includes("/404")
      ) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          const headers = new Headers(
            errorResponse(405, "", { https, security }).headers,
          );
          headers.set("allow", "GET, HEAD");
          return new Response("Method Not Allowed", { status: 405, headers });
        }
        // The asset layer serves 404.html at its own URL with 200 (and
        // redirects its aliases). Fetch the canonical asset and answer with
        // the status the Node server uses for the custom 404 page.
        const assetUrl = new URL(request.url);
        assetUrl.pathname = graph.base === "/" ? "/404" : `${graph.base}404`;
        assetUrl.search = "";
        const asset = await forwardToAssets(
          new Request(assetUrl, {
            method: request.method === "HEAD" ? "HEAD" : "GET",
            headers: request.headers,
          }),
          env,
        );
        if (asset.status !== 200) return asset;
        return new Response(request.method === "HEAD" ? null : asset.body, {
          status: 404,
          headers: asset.headers,
        });
      }
      return forwardToAssets(request, env);
    }

    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      const headers = new Headers(
        errorResponse(405, "", { https, security }).headers,
      );
      headers.set("allow", "GET, HEAD");
      return new Response("Method Not Allowed", { status: 405, headers });
    }

    const status = page.is404 ? 404 : 200;
    const { plan, run } = createPageExecution(
      page,
      graph,
      request,
      { remoteIp, platform },
      log,
    );

    if (plan.firstStreamIndex === -1 || isHead) {
      let body: Uint8Array;
      try {
        body = await composeBufferedResponse(plan, run, request.signal);
      } catch (err) {
        log(err instanceof Error ? err.message : String(err));
        return internalErrorPage(graph.custom500, { https, security });
      }
      const headers = dynamicPageHeaders({
        https,
        security,
        contentLength: body.byteLength,
      });
      setPageCsp(headers, page.path);
      return new Response(isHead ? null : body, { status, headers });
    }

    // Early flush: every `server` job settles before headers commit; the
    // Response carries a demand-gated ReadableStream and is returned BEFORE
    // the body completes. Stream failures are logged, never a status change.
    const streamer = streamComposedResponse(plan, run, undefined, {
      signal: request.signal,
      onStreamError: (err) =>
        log(err instanceof Error ? err.message : String(err)),
    });
    try {
      await streamer.ready;
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      return internalErrorPage(graph.custom500, { https, security });
    }
    const headers = stripRepresentationHeaders(
      dynamicPageHeaders({ https, security }),
    );
    setPageCsp(headers, page.path);
    // The edge compresses Worker responses on the fly and, for a streamed
    // body, holds every byte until the stream closes (observed in workerd:
    // only the gzip header leaves early). An explicit identity encoding opts
    // this response out so the static prefix reaches the browser now. Static
    // assets keep edge compression; only progressively rendered documents pay
    // the uncompressed cost, which is the price of early paint.
    headers.set("content-encoding", "identity");
    // Keep the isolate alive until the last fragment is written even if the
    // platform would otherwise consider the request finished.
    ctx.waitUntil(streamer.done);
    return new Response(streamer.toReadableStream(), { status, headers });
  };

  return { fetch: fetchHandler };
};
