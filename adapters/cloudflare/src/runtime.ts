/**
 * @module adapters/cloudflare-runtime
 *
 * The request handler that runs inside a Cloudflare Worker (prompt 134).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Portable: no Node imports. It is bundled into the generated `_worker.js`
 * together with the site graph emitted by `serverless-artifacts.ts`, and it
 * drives the same execution core the Node server uses
 * (`lib/request-execution.ts`).
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

import {
  composeBufferedResponse,
  dispatchApiHandler,
  invokeWithDeadline,
  streamComposedResponse,
  type ApiHandlerContext,
  type ApiHandlerModule,
  type ExecutionPlan,
  type ExecutionSegment,
  type PlatformContext,
  type ScriptJobRunner,
  dynamicPageHeaders,
  errorResponse,
  internalErrorPage,
  mergeHandlerHeaders,
  stripRepresentationHeaders,
  GENERATED_CONTROL_PATHS,
  hasHiddenSegment,
  isUnsafePathname,
  matchApiRoute,
  pageLookupCandidates,
  type ApiRouteDefinition,
} from "@bascik/bascik/runtime";

// ─── Site graph contract (emitted by serverless-artifacts.ts) ────────────────

/** A request-time script job inside a dynamic page template. */
export interface GraphScriptJob {
  id: string;
  mode: "server" | "stream";
  /** Loader for the compiled module; `default` is the handler. */
  load: () => Promise<{ default: unknown }>;
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
  /** Sorted API routes (static before dynamic). */
  apiRoutes: GraphApiRoute[];
  /** Optional authored 500 page body. */
  custom500?: string;
  /** Release identity for diagnostics headers. */
  release: string;
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
  fetch(request: Request, env: CloudflareEnv, ctx: CloudflareExecutionContext): Promise<Response>;
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

const isHttps = (request: Request): boolean => new URL(request.url).protocol === "https:";

const toExecutionPlan = (page: GraphPage): ExecutionPlan => {
  const segments: ExecutionSegment[] = page.segments.map((segment) =>
    segment.kind === "static"
      ? { kind: "static", bytes: encoder.encode(segment.text ?? "") }
      : { kind: "script", mode: page.jobs[segment.id!].mode, id: segment.id! },
  );
  return { segments, firstStreamIndex: segments.findIndex((s) => s.kind === "script" && s.mode === "stream") };
};

const findPage = (graph: SiteGraph, pathname: string): GraphPage | undefined => {
  for (const candidate of pageLookupCandidates(pathname)) {
    const page = graph.pages[candidate];
    if (page) return page;
  }
  return undefined;
};

/**
 * Build a `ScriptJobRunner` for one request. Output handling mirrors
 * `runServerScriptJob`: a string or stringifiable value is the fragment;
 * failure under `onServerScriptError: "error"` throws (500 before commit,
 * empty after), `warn` logs and yields empty, `ignore` yields empty.
 */
export const createGraphJobRunner = (
  page: GraphPage,
  graph: SiteGraph,
  request: Request,
  context: { remoteIp: string; platform: PlatformContext },
  log: (message: string) => void,
): ScriptJobRunner => {
  return async (id, signal) => {
    const job = page.jobs[id];
    if (!job) throw new Error(`[bascik] server script job "${id}" is missing from the deployment graph.`);
    const result = await invokeWithDeadline(
      async ({ signal: jobSignal }) => {
        const mod = await job.load();
        const handler = mod.default;
        if (typeof handler !== "function") {
          throw new TypeError(`Server script "${id}" does not export a default function.`);
        }
        return handler(request, context, { signal: jobSignal });
      },
      { timeoutMs: graph.scriptTimeoutMs, signal },
    );
    if (result.ok) {
      const value = result.value;
      return typeof value === "string" ? value : value !== undefined && value !== null ? String(value) : "";
    }
    if (result.aborted && !result.timedOut) return "";
    const error = result.error ?? new Error("Server script failed");
    const message = `[bascik] server script error at "${new URL(request.url).pathname}":\n${error.stack ?? error.message}`;
    if (graph.onServerScriptError === "error") throw new Error(message);
    if (graph.onServerScriptError === "warn") log(message);
    return "";
  };
};

export interface CreateWorkerOptions {
  /** Diagnostics sink; defaults to `console.error`. Never reaches the client. */
  log?: (message: string) => void;
}

/**
 * Build the Module Worker `fetch` handler for a site graph. The returned
 * object is what `_worker.js` exports as `default`.
 */
export const createCloudflareWorker = (graph: SiteGraph, options: CreateWorkerOptions = {}): CloudflareWorker => {
  const log = options.log ?? ((message: string) => console.error(message));

  const forwardToAssets = async (request: Request, env: CloudflareEnv): Promise<Response> => {
    if (!env.ASSETS) {
      log("[bascik] ASSETS binding is missing: static requests cannot be served.");
      return errorResponse(500, "Internal Server Error", { https: isHttps(request) });
    }
    return env.ASSETS.fetch(request);
  };

  const fetchHandler = async (request: Request, env: CloudflareEnv, ctx: CloudflareExecutionContext): Promise<Response> => {
    const https = isHttps(request);
    const url = new URL(request.url);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return errorResponse(400, "Bad Request", { https });
    }
    if (isUnsafePathname(pathname)) return errorResponse(400, "Bad Request", { https });
    if (hasHiddenSegment(pathname)) return errorResponse(404, "Not Found", { https });

    const baseRelative = stripBase(pathname, graph.base);
    if (baseRelative === null) return errorResponse(404, "Not Found", { https });
    // The bundle and its routing table are deployment control files, never
    // content. Refusing them here makes the guarantee independent of how a
    // host treats underscore-prefixed uploads.
    if (CONTROL_PATHS.has(baseRelative)) return errorResponse(404, "Not Found", { https });

    const platform: PlatformContext = {
      name: "cloudflare",
      env,
      waitUntil: (promise) => ctx.waitUntil(promise),
    };
    const remoteIp = cloudflareRemoteIp(request);

    // ── API routes (before the method guard so every method reaches them) ──
    const apiMatch = matchApiRoute(graph.apiRoutes, pathname);
    if (apiMatch) {
      const route = apiMatch.route as GraphApiRoute;
      let mod: ApiHandlerModule;
      try {
        mod = await route.load();
      } catch (err) {
        log(`[bascik] Failed to load API route module ${route.filePath}: ${(err as Error).stack ?? String(err)}`);
        return errorResponse(500, "Internal Server Error", { https });
      }
      const context: ApiHandlerContext = { params: apiMatch.params, remoteIp, platform };
      const response = await dispatchApiHandler(mod, request, context, {
        timeoutMs: graph.apiTimeoutMs,
        signal: request.signal,
        onError: (message, error) => log(`[bascik] ${message}${error ? `\n${(error as Error).stack ?? String(error)}` : ""}`),
      });
      const headers = mergeHandlerHeaders(response.headers, { https });
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // ── Dynamic pages ─────────────────────────────────────────────────────
    const page = findPage(graph, baseRelative);
    if (!page) return forwardToAssets(request, env);

    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      const headers = new Headers(errorResponse(405, "", { https }).headers);
      headers.set("allow", "GET, HEAD");
      return new Response("Method Not Allowed", { status: 405, headers });
    }

    const status = page.is404 ? 404 : 200;
    const plan = toExecutionPlan(page);
    const run = createGraphJobRunner(page, graph, request, { remoteIp, platform }, log);

    if (plan.firstStreamIndex === -1 || isHead) {
      let body: Uint8Array;
      try {
        body = await composeBufferedResponse(plan, run, request.signal);
      } catch (err) {
        log(err instanceof Error ? err.message : String(err));
        return internalErrorPage(graph.custom500, { https });
      }
      const headers = dynamicPageHeaders({ https, contentLength: body.byteLength });
      return new Response(isHead ? null : body, { status, headers });
    }

    // Early flush: every `server` job settles before headers commit; the
    // Response carries a demand-gated ReadableStream and is returned BEFORE
    // the body completes. Stream failures are logged, never a status change.
    const streamer = streamComposedResponse(plan, run, undefined, {
      signal: request.signal,
      onStreamError: (err) => log(err instanceof Error ? err.message : String(err)),
    });
    try {
      await streamer.ready;
    } catch (err) {
      log(err instanceof Error ? err.message : String(err));
      return internalErrorPage(graph.custom500, { https });
    }
    const headers = stripRepresentationHeaders(dynamicPageHeaders({ https }));
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
