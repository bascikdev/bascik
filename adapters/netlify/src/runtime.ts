/**
 * @module runtime
 *
 * The request handler that runs inside the generated Netlify Function
 * (Functions API v2). It is bundled into `bascik-pages.mjs` with the site
 * graph build.ts emits and drives the same execution core the Node server
 * and the Cloudflare Worker use.
 *
 * Netlify routes only the function's `config.path` patterns here (every alias
 * of each dynamic page, and the API routes); its CDN serves every other file.
 *
 *   handler(request, context)
 *     ├─ unsafe or hidden path                -> 400 / 404
 *     ├─ outside `base`                       -> 404
 *     ├─ API route match                      -> dispatchApiHandler(...)
 *     ├─ dynamic page alias match             -> compose from the graph's template
 *     │     ├─ no stream jobs or HEAD         -> buffered body, content-length
 *     │     └─ stream jobs                    -> Response(ReadableStream) before body completes
 *     └─ anything else                        -> 404
 *
 * Handlers get `context.platform` as `{ name: "netlify", context, waitUntil }`.
 *
 * Diagnostics: one `request.start` line before anything else runs, a
 * `script.*` line per server, stream and component script, every error with
 * its stack, and one summary line per request (see the README). Every
 * response carries `X-Bascik-Handler: bascik-pages`, so a response without it
 * did not come from this function.
 */

import { componentExecution } from "./component-host.js";
import {
  applyOutputScope,
  collectScriptJobOutput,
  composeBufferedResponse,
  contentSecurityPolicyHeader,
  decodeOutputScope,
  dispatchApiHandler,
  dynamicPageHeaders,
  errorResponse,
  internalErrorPage,
  invokeLoadedWithDeadline,
  InvalidApiPathError,
  isPrivatePathname,
  isUnsafePathname,
  matchApiRoute,
  mergeHandlerHeaders,
  pageLookupCandidates,
  scriptChunkOutput,
  scriptTimeoutError,
  serverScriptOutput,
  serverScriptOutputErrorMessage,
  streamComposedResponse,
  stripAnsiEscapeCodes,
  stripRepresentationHeaders,
  type ApiHandlerContext,
  type ApiHandlerModule,
  type ApiRouteDefinition,
  type ContentSecurityPolicyConfig,
  type CspRouteHashes,
  type ExecutionPlan,
  type ExecutionSegment,
  type InvokeResult,
  type PlatformContext,
  type RenderHost,
  type RequestRenderLimits,
  type ResponseSecurity,
  type ScriptJobOutput,
  type ScriptJobRunner,
  type ScriptOutputRunner,
} from "@bascik/bascik/runtime";

// ─── Site graph contract (emitted by build.ts) ──────────────────────────────

/** A request-time script job: a page's, or a component's. */
export interface GraphScriptJob {
  id: string;
  mode: "server" | "stream";
  /** The component's element classes, applied to the job's output. */
  outputScope?: string;
  /** Where a component script is authored, to locate its failures. */
  owner?: string;
  /** Loader for the compiled module; `default` is the handler. */
  load: () => Promise<{ default?: unknown }>;
}

export type ComponentManifest = NonNullable<RenderHost["manifest"]>;

/** Components script output may return, and their scripts by job id. */
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
  is404: boolean;
  segments: GraphPageSegment[];
  jobs: Record<string, GraphScriptJob>;
}

export interface GraphApiRoute extends ApiRouteDefinition {
  load: () => Promise<ApiHandlerModule>;
}

export interface SiteGraph {
  /** Normalized base path, starting and ending with `/`. Absent: `/`. */
  base?: string;
  /** Deadline for server and stream jobs, ms. */
  scriptTimeoutMs: number;
  /** Deadline for API handlers, ms. Absent: the script deadline. */
  apiTimeoutMs?: number;
  onServerScriptError: "error" | "warn" | "ignore";
  /** Dynamic pages by canonical path. */
  pages: Record<string, GraphPage>;
  /** Sorted API routes (static, then `[param]`, then catch-all). */
  apiRoutes?: GraphApiRoute[];
  /** Optional authored 500 page body. */
  custom500?: string;
  /** Present when the site renders component tags in script output. */
  components?: GraphComponents;
  contentSecurityPolicy?: {
    policy: ContentSecurityPolicyConfig;
    hashes: Record<string, CspRouteHashes>;
  };
  responseSecurity?: ResponseSecurity;
  /** The build's `security.hideDotfiles`. Absent: true. */
  hideDotfiles?: boolean;
  /** The build's `scripts.stripAnsi`. Absent: true. */
  stripAnsi?: boolean;
  renderLimits?: Partial<RequestRenderLimits>;
}

/** The parts of Netlify's function `Context` the runtime reads. */
export interface NetlifyContext {
  ip?: string;
  waitUntil?: (promise: Promise<unknown>) => void;
  [key: string]: unknown;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

/** One summary line per request, so `netlify logs` can be filtered and parsed. */
export interface RequestLogEntry {
  fn: "bascik-pages";
  requestId: string | null;
  method: string;
  path: string;
  status: number;
  ms: number;
  mode: "buffered" | "stream" | "api";
  /** Cookie names and value sizes, never values. */
  cookieBytes: number;
  cookies: Record<string, number>;
  error?: string;
  stack?: string;
}

export interface DiagnosticLogEntry {
  fn: "bascik-pages";
  event:
    | "request.start"
    | "request.error"
    | "script.start"
    | "script.complete"
    | "script.error";
  requestId: string | null;
  path: string;
  method: string;
  scriptId?: string;
  mode?: GraphScriptJob["mode"];
  ms?: number;
  error?: string;
  stack?: string;
}

export interface CreateHandlerOptions {
  /** Error sink (JSON lines); defaults to `console.error`. Never reaches the client. */
  log?: (message: string) => void;
  /** Summary sink; defaults to `console.log` of the JSON entry. */
  logRequest?: (entry: RequestLogEntry) => void;
  /** Progress sink; defaults to `console.info` of the JSON entry. */
  logEvent?: (entry: DiagnosticLogEntry) => void;
}

const errorFacts = (error: unknown): { error: string; stack?: string } =>
  error instanceof Error
    ? { error: error.message, ...(error.stack ? { stack: error.stack } : {}) }
    : { error: String(error) };

const cookieFacts = (request: Request) => {
  const header = request.headers.get("cookie") ?? "";
  const cookies: Record<string, number> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) cookies[part.slice(0, eq).trim()] = part.length - eq - 1;
  }
  return { cookieBytes: header.length, cookies };
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

const encoder = new TextEncoder();

export const stripBase = (pathname: string, base: string): string | null => {
  if (base === "/") return pathname;
  const prefix = base.endsWith("/") ? base.slice(0, -1) : base;
  if (pathname === prefix) return "/";
  if (!pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length);
};

export const findPage = (
  graph: SiteGraph,
  pathname: string,
): GraphPage | undefined => {
  for (const candidate of pageLookupCandidates(pathname)) {
    const page = graph.pages[candidate];
    if (page) return page;
  }
  return undefined;
};

const toExecutionPlan = (page: GraphPage): ExecutionPlan => {
  const segments: ExecutionSegment[] = page.segments.map((segment) => {
    if (segment.kind === "static")
      return { kind: "static", bytes: encoder.encode(segment.text ?? "") };
    const job = page.jobs[segment.id!];
    // A segment naming no job still plans; running it reports the gap.
    return { kind: "script", mode: job?.mode ?? "server", id: segment.id! };
  });
  return {
    segments,
    firstStreamIndex: segments.findIndex(
      (s) => s.kind === "script" && s.mode === "stream",
    ),
  };
};

const missingJob = (id: string): Error =>
  new Error(
    `[bascik] server script job "${id}" is missing from the deployment graph.`,
  );

/** Jobs whose refused return value was already logged by this instance. */
const warnedRefused = new WeakSet<GraphScriptJob>();

/**
 * Run one job under `timeoutMs`, exactly as the Node server and the
 * Cloudflare Worker do: the printed fragment, ANSI-stripped, scoped when the
 * job carries a scope; a refused return value is an empty slot logged once;
 * a failure throws under "error", logs under "warn", is empty under "ignore".
 *
 * A script that yields (a generator) gives an iterable instead of a string:
 * each value it yields is printed by the same rule, under the same deadline
 * (which counts only the time the script takes to produce values) and the
 * same policy. A yielded value that is not markup is skipped, and a failed
 * pull ends the output there, thrown from `next()` under "error".
 */
const runGraphJobOutput = async (
  job: GraphScriptJob,
  id: string,
  graph: SiteGraph,
  request: Request,
  context: { remoteIp: string; platform: PlatformContext },
  log: (message: string) => void,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<ScriptJobOutput> => {
  const invoked = await invokeLoadedWithDeadline(
    () => job.load(),
    (mod, { signal: jobSignal }) => {
      const handler = mod.default;
      if (typeof handler !== "function") {
        throw new TypeError(
          `Server script "${id}" does not export a default function.`,
        );
      }
      return handler(request, context, { signal: jobSignal }) as unknown;
    },
    {
      timeoutMs,
      ...(signal ? { signal } : {}),
      timeoutError: scriptTimeoutError,
      chunks: true,
    },
  );
  if (invoked.ok && invoked.source) {
    return scriptChunkOutput(
      invoked.source,
      (value) =>
        settle({ ok: true, value, timedOut: false, aborted: false }, true),
      (failed) => settle(failed, true),
    );
  }
  return settle(invoked, false);

  /** The output of one settled call or pull, by the policy above. */
  function settle(result: InvokeResult<unknown>, yielded: boolean): string {
    let printed: ReturnType<typeof serverScriptOutput> | undefined;
    let failure: Error | undefined;
    if (result.ok) {
      try {
        printed = serverScriptOutput(result.value);
      } catch (thrown) {
        failure = thrown instanceof Error ? thrown : new Error(String(thrown));
      }
    }
    if (printed) {
      if (printed.error) {
        if (graph.onServerScriptError !== "ignore" && !warnedRefused.has(job)) {
          warnedRefused.add(job);
          log(
            serverScriptOutputErrorMessage(
              printed.error,
              request.url,
              job.owner ?? `${job.mode} script`,
              { production: true, yielded },
            ),
          );
        }
        return "";
      }
      const text =
        graph.stripAnsi === false
          ? printed.text
          : stripAnsiEscapeCodes(printed.text);
      const scope = decodeOutputScope(job.outputScope);
      return scope ? applyOutputScope(text, scope) : text;
    }
    if (!failure && !result.ok && result.aborted && !result.timedOut) return "";
    const error =
      failure ??
      (!result.ok ? result.error : undefined) ??
      new Error("Server script failed");
    const err = error instanceof Error ? error : new Error(String(error));
    const where = job.owner ? `\n    in the ${job.owner}` : "";
    const message = `[bascik] server script error at "${new URL(request.url).pathname}":\n${err.stack ?? err.message}${where}`;
    if (graph.onServerScriptError === "error") throw new Error(message);
    if (graph.onServerScriptError === "warn") log(message);
    return "";
  }
};

/** `runGraphJobOutput` with a yielding script's values joined into one string. */
const runGraphJob = async (
  ...args: Parameters<typeof runGraphJobOutput>
): Promise<string> => collectScriptJobOutput(await runGraphJobOutput(...args));

/**
 * A yielding job's chunks, passed through: `complete` is called once after
 * the last one, `failed` once when a pull throws. A consumer that stops
 * early closes the job and neither is called.
 */
const tracedChunks = (
  output: AsyncIterable<string>,
  complete: () => void,
  failed: (error: unknown) => void,
): AsyncIterable<string> => {
  const inner = output[Symbol.asyncIterator]();
  let ended = false;
  const done: IteratorResult<string> = { done: true, value: undefined };
  const chunks: AsyncIterator<string> = {
    async next() {
      if (ended) return done;
      try {
        const step = await inner.next();
        if (step.done) {
          ended = true;
          complete();
        }
        return step;
      } catch (error) {
        ended = true;
        failed(error);
        throw error;
      }
    },
    async return() {
      ended = true;
      await inner.return?.();
      return done;
    },
  };
  return { [Symbol.asyncIterator]: () => chunks };
};

// ─── Handler ─────────────────────────────────────────────────────────────────

/** Build the Netlify Function handler (`export default`) for a site graph. */
export const createNetlifyHandler = (
  graph: SiteGraph,
  options: CreateHandlerOptions = {},
) => {
  const log = options.log ?? ((message: string) => console.error(message));
  const logRequest =
    options.logRequest ??
    ((entry: RequestLogEntry) => console.log(JSON.stringify(entry)));
  const logEvent =
    options.logEvent ??
    ((entry: DiagnosticLogEntry) => console.info(JSON.stringify(entry)));
  const base = graph.base ?? "/";
  const apiRoutes = graph.apiRoutes ?? [];
  const security = graph.responseSecurity;
  const hideDotfiles = graph.hideDotfiles !== false;

  const event = (
    request: Request,
    name: DiagnosticLogEntry["event"],
    details: Partial<
      Pick<DiagnosticLogEntry, "scriptId" | "mode" | "ms" | "error" | "stack">
    > = {},
  ): DiagnosticLogEntry => ({
    fn: "bascik-pages",
    event: name,
    requestId: request.headers.get("x-nf-request-id"),
    path: new URL(request.url).pathname,
    method: request.method,
    ...details,
  });

  const setPageCsp = (headers: Headers, path: string): void => {
    const csp = graph.contentSecurityPolicy;
    if (!csp) return;
    const { name, value } = contentSecurityPolicyHeader(
      csp.policy,
      csp.hashes[path],
    );
    headers.set(name, value);
  };

  /**
   * A runner that logs each job's start, completion and failure. A job that
   * yields completes with its last chunk, and a failure part-way is logged
   * like one from the call.
   */
  function traced(
    request: Request,
    runJob: (id: string, signal?: AbortSignal) => Promise<string>,
    modeOf: (id: string) => GraphScriptJob["mode"] | undefined,
  ): ScriptJobRunner;
  function traced(
    request: Request,
    runJob: (id: string, signal?: AbortSignal) => Promise<ScriptJobOutput>,
    modeOf: (id: string) => GraphScriptJob["mode"] | undefined,
  ): ScriptOutputRunner;
  function traced(
    request: Request,
    runJob: (id: string, signal?: AbortSignal) => Promise<ScriptJobOutput>,
    modeOf: (id: string) => GraphScriptJob["mode"] | undefined,
  ): ScriptOutputRunner {
    return async (id, signal) => {
      const started = performance.now();
      const mode = modeOf(id);
      const details = { scriptId: id, ...(mode ? { mode } : {}) };
      const complete = () =>
        logEvent(
          event(request, "script.complete", {
            ...details,
            ms: Math.round(performance.now() - started),
          }),
        );
      const failed = (error: unknown) =>
        log(
          JSON.stringify(
            event(request, "script.error", {
              ...details,
              ...errorFacts(error),
            }),
          ),
        );
      logEvent(event(request, "script.start", details));
      try {
        const output = await runJob(id, signal);
        if (typeof output !== "string")
          return tracedChunks(output, complete, failed);
        complete();
        return output;
      } catch (error) {
        failed(error);
        throw error;
      }
    };
  }

  const pageExecution = (
    page: GraphPage,
    request: Request,
    context: { remoteIp: string; platform: PlatformContext },
  ): { plan: ExecutionPlan; run: ScriptOutputRunner } => {
    const scriptLog = (message: string) =>
      log(JSON.stringify(event(request, "script.error", { error: message })));
    const jobFor = (id: string) => page.jobs[id] ?? graph.components?.jobs[id];
    const run = traced(
      request,
      async (id, signal) => {
        const job = jobFor(id);
        if (!job) throw missingJob(id);
        return runGraphJobOutput(
          job,
          id,
          graph,
          request,
          context,
          scriptLog,
          signal,
          graph.scriptTimeoutMs,
        );
      },
      (id) => jobFor(id)?.mode,
    );
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
            return traced(
              request,
              (jobId, jobSignal) =>
                runGraphJob(
                  job,
                  jobId,
                  graph,
                  request,
                  context,
                  scriptLog,
                  jobSignal,
                  budgetMs,
                ),
              () => job.mode,
            )(id, signal);
          },
          scriptLog,
        )
      : null;
    return rendered ?? { plan: toExecutionPlan(page), run };
  };

  const render = async (
    request: Request,
    netlifyContext: NetlifyContext,
    record: (
      status: number,
      mode: RequestLogEntry["mode"],
      error?: unknown,
    ) => void,
  ): Promise<Response> => {
    const url = new URL(request.url);
    const https = url.protocol === "https:";
    // Routing-level 400 and 404, as the Node server answers them: the
    // security headers and a content type, no cache policy.
    const fail = (status: number, text: string): Response => {
      record(status, "buffered");
      const response = errorResponse(status, text, { https, security });
      response.headers.delete("cache-control");
      return response;
    };
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      return fail(400, "Bad Request");
    }
    if (isUnsafePathname(pathname)) return fail(400, "Bad Request");
    if (isPrivatePathname(pathname, base, hideDotfiles))
      return fail(404, "Not Found");
    const baseRelative = stripBase(pathname, base);
    if (baseRelative === null) return fail(404, "Not Found");

    // Netlify's own Context (cookies, geo, site, deploy) rides along as
    // `platform.context`; environment variables stay in `process.env`.
    const platform = {
      name: "netlify",
      context: netlifyContext,
      ...(netlifyContext.waitUntil
        ? {
            waitUntil: (promise: Promise<unknown>) =>
              netlifyContext.waitUntil!(promise),
          }
        : {}),
    } as PlatformContext;
    const remoteIp = netlifyContext.ip ?? "";

    // ── API routes (before the method guard so every method reaches them) ──
    let apiMatch: ReturnType<typeof matchApiRoute<GraphApiRoute>>;
    try {
      apiMatch = matchApiRoute(apiRoutes, pathname, url.pathname);
    } catch (err) {
      if (!(err instanceof InvalidApiPathError)) throw err;
      return fail(400, "Bad Request");
    }
    if (apiMatch) {
      const route = apiMatch.route as GraphApiRoute;
      let mod: ApiHandlerModule;
      try {
        mod = await route.load();
      } catch (err) {
        log(
          JSON.stringify(
            event(request, "request.error", {
              error: `Failed to load API route module ${route.filePath}`,
              ...(err instanceof Error && err.stack
                ? { stack: err.stack }
                : {}),
            }),
          ),
        );
        record(500, "api", err);
        return errorResponse(500, "Internal Server Error", { https, security });
      }
      const context: ApiHandlerContext = {
        params: apiMatch.params,
        remoteIp,
        platform,
      };
      const response = await dispatchApiHandler(mod, request, context, {
        timeoutMs: graph.apiTimeoutMs ?? graph.scriptTimeoutMs,
        signal: request.signal,
        onError: (message, error) =>
          log(
            JSON.stringify(
              event(request, "request.error", {
                error: message,
                ...(error instanceof Error && error.stack
                  ? { stack: error.stack }
                  : {}),
              }),
            ),
          ),
      });
      const headers = mergeHandlerHeaders(response.headers, {
        https,
        security,
      });
      if (request.method === "HEAD" && response.body && !response.body.locked)
        response.body.cancel().catch(() => {});
      record(response.status, "api");
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }

    // ── Dynamic pages ─────────────────────────────────────────────────────
    const page = findPage(graph, baseRelative);
    if (!page) return fail(404, "Not Found");

    const isHead = request.method === "HEAD";
    if (request.method !== "GET" && !isHead) {
      const headers = new Headers(
        errorResponse(405, "", { https, security }).headers,
      );
      headers.set("allow", "GET, HEAD");
      // As the Node server answers: no cache policy on a page's 405.
      headers.delete("cache-control");
      record(405, "buffered");
      return new Response("Method Not Allowed", { status: 405, headers });
    }

    const status = page.is404 ? 404 : 200;
    const { plan, run } = pageExecution(page, request, { remoteIp, platform });

    if (plan.firstStreamIndex === -1 || isHead) {
      let body: Uint8Array;
      try {
        body = await composeBufferedResponse(plan, run, request.signal);
      } catch (err) {
        log(JSON.stringify(event(request, "request.error", errorFacts(err))));
        record(500, "buffered", err);
        return internalErrorPage(graph.custom500, { https, security });
      }
      const headers = dynamicPageHeaders({
        https,
        security,
        contentLength: body.byteLength,
      });
      setPageCsp(headers, page.path);
      record(status, "buffered");
      return new Response(isHead ? null : (body as Uint8Array<ArrayBuffer>), {
        status,
        headers,
      });
    }

    // Every server job settles before headers commit; stream failures after
    // that are logged and leave their slot empty.
    const streamer = streamComposedResponse(plan, run, undefined, {
      signal: request.signal,
      onStreamError: (err: unknown) =>
        log(JSON.stringify(event(request, "request.error", errorFacts(err)))),
    });
    try {
      await streamer.ready;
    } catch (err) {
      log(JSON.stringify(event(request, "request.error", errorFacts(err))));
      record(500, "stream", err);
      return internalErrorPage(graph.custom500, { https, security });
    }
    const finished = streamer.done.then(
      () => record(status, "stream"),
      (err: unknown) => record(status, "stream", err),
    );
    netlifyContext.waitUntil?.(finished);
    const headers = stripRepresentationHeaders(
      dynamicPageHeaders({ https, security }),
    );
    setPageCsp(headers, page.path);
    return new Response(streamer.toReadableStream(), { status, headers });
  };

  return async function handler(
    request: Request,
    netlifyContext: NetlifyContext = {},
  ): Promise<Response> {
    // Logged before graph setup and lazy script imports, so a request that
    // reaches the function always leaves a trace.
    logEvent(event(request, "request.start"));
    const started = performance.now();
    const record = (
      status: number,
      mode: RequestLogEntry["mode"],
      error?: unknown,
    ): void => {
      logRequest({
        fn: "bascik-pages",
        requestId: request.headers.get("x-nf-request-id"),
        method: request.method,
        path: new URL(request.url).pathname,
        status,
        ms: Math.round(performance.now() - started),
        mode,
        ...cookieFacts(request),
        ...(error === undefined ? {} : errorFacts(error)),
      });
    };
    let response: Response;
    try {
      response = await render(request, netlifyContext, record);
    } catch (error) {
      log(JSON.stringify(event(request, "request.error", errorFacts(error))));
      record(500, "buffered", error);
      response = internalErrorPage(graph.custom500, {
        https: new URL(request.url).protocol === "https:",
        security,
      });
    }
    // A WebSocket upgrade's or other immutable response's headers cannot be
    // changed; the marker is best effort there.
    try {
      response.headers.set("X-Bascik-Handler", "bascik-pages");
    } catch {
      // Immutable headers.
    }
    return response;
  };
};
