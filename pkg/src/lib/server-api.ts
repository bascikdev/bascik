/**
 * @module server-api
 *
 * API Route Dispatcher for HTTP/1.1 and HTTP/2 Servers
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Scans, caches, matches, and dispatches requests to API route handlers.
 * Zero overhead when `directory.api` does not exist.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { BascikConfig } from "./config.ts";
import {
  scanApiRouteFiles,
  buildApiRouteTree,
  matchApiRoute,
  type ApiRouteDefinition,
  type ApiRouteMatch,
} from "./api-routes.ts";
import {
  createWebRequest,
  executeApiRoute,
  declaresBodyOverLimit,
  requestOrigin,
} from "./api-runtime.ts";
import {
  createResponseSink,
  type DisposableResponseSink,
} from "./response-sink.ts";
import { isNetworkResetError } from "./server.ts";
import { scriptRegistry } from "./script-registry.ts";
import { allowHeaderFor } from "./request-execution.ts";
import type { BascikRequest, BascikResponse } from "./server.ts";

/** Methods the fetch `Request` constructor refuses (Fetch, "forbidden method"). */
const FETCH_FORBIDDEN_METHODS = new Set(["CONNECT", "TRACE", "TRACK"]);

/**
 * 405 with the route's `Allow` for a method no `Request` can carry. The
 * module is loaded only to name its methods; a load failure is the same
 * logged 500 any method gets.
 */
const rejectForbiddenMethod = async (
  res: BascikResponse,
  match: ApiRouteMatch,
  secHeaders: Record<string, string>,
): Promise<number> => {
  let allow: string;
  try {
    const loaded = await scriptRegistry.load(match.route.filePath);
    allow = allowHeaderFor(loaded.module as Record<string, unknown>);
  } catch (err) {
    console.error(
      "[bascik] Failed to load API route module %s:",
      match.route.filePath,
      (err as Error)?.stack ?? String(err),
    );
    const body = "Internal Server Error";
    res.respond(500, {
      ...secHeaders,
      "content-type": "text/plain; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
    });
    res.end(body);
    return 500;
  }
  const body = "Method Not Allowed";
  res.respond(405, {
    ...secHeaders,
    allow,
    "content-type": "text/plain; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
  });
  res.end(body);
  return 405;
};

/**
 * The largest response body `dispatch` buffers to give it a Content-Length
 * while the transport drains a rejected request body. An error page is far
 * smaller; a larger body streams as before.
 */
export const LINGER_FRAMED_BODY_LIMIT = 64 * 1024;

/**
 * Reads `body` whole when it fits in `limit` bytes. Otherwise (too large,
 * failed, or the client left) returns a stream that replays what was read
 * and then continues with the rest, so `streamApiResponse` handles it
 * exactly as it would the original.
 */
const readBounded = async (
  body: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal,
): Promise<{ whole: Buffer } | { rest: ReadableStream<Uint8Array> }> => {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let failure: { error: unknown } | undefined;
  try {
    while (bytes <= limit && !signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        return { whole: Buffer.concat(chunks) };
      }
      if (value) {
        chunks.push(value);
        bytes += value.byteLength;
      }
    }
  } catch (error) {
    failure = { error };
  }
  return {
    rest: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (failure) controller.error(failure.error);
      },
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    }),
  };
};

/**
 * Stream a WHATWG Response body to a BascikResponse with backpressure and
 * disconnect ownership (prompt 110).
 *
 * Ownership contract:
 * - `abort` is the single request-lifetime controller. `createResponseSink`
 *   aborts it when the client disconnects and awaits `drain` after a `false`
 *   write, so socket capacity gates body consumption instead of buffering an
 *   unbounded streamed body.
 * - A disconnect while a read is pending aborts the shared controller, which
 *   cancels the active reader via the `aborted` promise. Reader cancellation
 *   and handler settlement (inside `executeApiRoute`) settle independently, so
 *   cleanup never waits on noncooperative user code.
 * - Producer failure is distinguished from network cancellation. Before the
 *   header set is committed the client gets a normal error response with no
 *   body; after commit the transport is closed as truncated, never ended as a
 *   successful complete response and never given a second header set.
 * - Completion releases the reader and removes listeners exactly once.
 */
export const streamApiResponse = async (
  body: ReadableStream<Uint8Array>,
  status: number,
  outHeaders: Record<string, any>,
  secHeaders: Record<string, string>,
  res: BascikResponse,
  abort: AbortController,
  sink: DisposableResponseSink,
): Promise<void> => {
  const reader = body.getReader();
  // `closed` rejects when the producer errors; it is observed via read().
  reader.closed.catch(() => {});

  let unlistenAbort: (() => void) | undefined;
  // Settled (never rejecting) once reader cancellation has completed. Cancel on
  // an already-errored stream rejects with the stored producer error, so the
  // rejection is absorbed here exactly once and never re-propagated.
  let cancelSettled: Promise<void> | undefined;

  const aborted = new Promise<void>((resolve) => {
    const listener = (): void => {
      cancelSettled = reader.cancel().catch(() => {});
      resolve();
    };
    if (abort.signal.aborted) {
      listener();
    } else {
      abort.signal.addEventListener("abort", listener, { once: true });
      unlistenAbort = () => abort.signal.removeEventListener("abort", listener);
    }
  });

  let headersCommitted = false;

  try {
    while (true) {
      const currentRead = reader.read();
      // The race may be won by `aborted`, leaving `currentRead` to settle
      // later (it rejects once the reader is canceled). Observe that
      // rejection here so it can never surface as an unhandled rejection.
      currentRead.catch(() => {});
      const readResult = await Promise.race([currentRead, aborted]);
      if (abort.signal.aborted || !readResult) return;
      const { done, value } = readResult;
      if (done) break;
      if (!headersCommitted) {
        headersCommitted = true;
        res.respond(status, outHeaders);
      }
      if (value) await sink.write(Buffer.from(value));
    }

    if (!abort.signal.aborted && !res.destroyed) {
      if (!headersCommitted) {
        headersCommitted = true;
        res.respond(status, outHeaders);
      }
      res.end();
    }
  } catch (err) {
    if (headersCommitted) {
      try {
        res.close();
      } catch {}
      if (!isNetworkResetError(err)) {
        console.error(
          "[bascik] API route body stream failed after commit:",
          err,
        );
      }
    } else {
      // The header set is uncommitted, so the client gets a complete error
      // response. `respond` alone only writes headers on both transports
      // (`writeHead` / `stream.respond`); without `end` a real client hangs.
      try {
        if (!res.destroyed) {
          res.respond(500, {
            "content-type": "text/plain; charset=utf-8",
            ...secHeaders,
          });
          res.end("Internal Server Error");
        }
      } catch {}
    }
  } finally {
    if (unlistenAbort) unlistenAbort();
    // Release the reader lock exactly once. After a disconnect the lock is
    // released only once cancellation has settled, so an in-flight read is
    // never released underneath the cancel; otherwise release immediately.
    const release = (): void => {
      try {
        reader.releaseLock();
      } catch {
        // Lock already released by the stream (errored/closed).
      }
    };
    if (cancelSettled) {
      void cancelSettled.then(release);
    } else {
      release();
    }
    sink.dispose();
  }
};

export class ApiRouteRegistry {
  private routes: ApiRouteDefinition[] = [];
  private scanned = false;
  private apiDir: string = "";

  /**
   * Initializes or refreshes the API route tree from disk.
   */
  async init(apiDir?: string, basePath?: string): Promise<void> {
    const targetDir = apiDir ?? BascikConfig.directory?.api ?? "src/api";
    const targetBase = basePath ?? BascikConfig.base ?? "/";
    this.apiDir = resolve(process.cwd(), targetDir);
    this.scanned = true;

    if (!existsSync(this.apiDir)) {
      this.routes = [];
      return;
    }

    const files = await scanApiRouteFiles(this.apiDir);
    this.routes = buildApiRouteTree(files, this.apiDir, targetBase);
  }

  /**
   * Returns whether any API routes exist.
   */
  hasRoutes(): boolean {
    return this.routes.length > 0;
  }

  /**
   * Returns all registered route definitions.
   */
  getRoutes(): ApiRouteDefinition[] {
    return this.routes;
  }

  /**
   * Match an incoming request pathname. `rawPathname` is the undecoded path
   * (query and fragment removed); catch-all routes split and decode it
   * themselves. Throws `InvalidApiPathError` for an unsafe catch-all capture.
   */
  match(
    pathname: string,
    rawPathname: string = pathname,
  ): ApiRouteMatch | null {
    if (this.routes.length === 0) return null;
    return matchApiRoute(this.routes, pathname, rawPathname);
  }

  /**
   * Invalidate a single route file or all routes when files change in dev.
   */
  async reload(basePath = BascikConfig.base): Promise<void> {
    if (!this.scanned) return;
    await this.init(BascikConfig.directory.api, basePath);
  }

  /**
   * Invalidate a specific route file in the script registry and rebuild route tree.
   */
  async invalidateFile(
    filePath: string,
    basePath = BascikConfig.base,
  ): Promise<void> {
    scriptRegistry.invalidate(filePath);
    await this.reload(basePath);
  }

  /**
   * Dispatch a matching API route request.
   *
   * The handler is invoked under a request-lifetime AbortController that the
   * response sink aborts on client close. Disconnecting therefore reaches the
   * handler's signal. The handler is raced against that disconnect so a
   * noncooperative handler never holds dispatch open; the sink is disposed
   * exactly once regardless of which settles first.
   */
  async dispatch(
    req: BascikRequest,
    res: BascikResponse,
    match: ApiRouteMatch,
    secHeaders: Record<string, string>,
  ): Promise<number> {
    // Tells the transport, once, that the rest of the body will never be
    // read, so it drains it (bounded) instead of closing under a client that
    // is still uploading. It runs the moment the body is rejected, whether
    // that is before `respond` (the runtime's 413, or the handler's own
    // response after catching the error) or after it (a response that
    // streams the request body back trips the limit mid-stream).
    let lingering = false;
    const linger = (): void => {
      if (lingering) return;
      lingering = true;
      res.lingerClose?.();
    };

    // Early path: a declared length over the limit proves the body is too
    // large before a byte is read. The handler never runs and its request
    // carries no body, so nothing pulls the upload (or, for an
    // `Expect: 100-continue` client, asks for it) just to reject it.
    // CONNECT, TRACE and TRACK are forbidden methods to fetch: the
    // `Request` constructor throws on them, so they never reach the shared
    // method policy. No handler can be exported for them, so they get the
    // policy's answer for any unexported method, 405 with Allow.
    if (FETCH_FORBIDDEN_METHODS.has(req.method?.toUpperCase() ?? "")) {
      return rejectForbiddenMethod(res, match, secHeaders);
    }

    const declaredTooLarge = declaresBodyOverLimit(req.method, req.headers);
    const webReq = createWebRequest(
      declaredTooLarge ? { ...req, rawStream: undefined } : req,
      requestOrigin(req),
      undefined,
      linger,
    );
    const abort = new AbortController();
    const sink = createResponseSink(res, abort);

    // Resolves when the client disconnects (the sink aborts `abort` on close).
    // The handler signal is forwarded to `executeApiRoute` so disconnect is
    // observable inside the handler; the race here only keeps dispatch from
    // hanging on a handler that ignores its signal.
    const aborted = new Promise<void>((resolve) => {
      const onAbort = (): void => resolve();
      abort.signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      const webRes = await Promise.race([
        executeApiRoute({
          filePath: match.route.filePath,
          request: webReq,
          params: match.params,
          remoteIp: req.remoteIp,
          signal: abort.signal,
          onDeclaredBodyTooLarge: declaredTooLarge ? linger : undefined,
        }),
        aborted.then(() => null),
      ]);

      // Disconnected while the handler was in flight: nothing to deliver.
      if (abort.signal.aborted || !webRes) return 0;

      // Merge headers: security headers first, handler headers overwrite.
      const outHeaders: Record<string, any> = { ...secHeaders };

      // Standard headers iterator.
      webRes.headers.forEach((value, key) => {
        outHeaders[key] = value;
      });

      // Special handling for set-cookie headers: preserve multiple Set-Cookie.
      if (typeof (webRes.headers as any).getSetCookie === "function") {
        const setCookies = (webRes.headers as any).getSetCookie();
        if (Array.isArray(setCookies) && setCookies.length > 0) {
          outHeaders["set-cookie"] =
            setCookies.length === 1 ? setCookies[0] : setCookies;
        }
      }

      if (webRes.body) {
        const isHead = req.method?.toUpperCase() === "HEAD";
        let body = webRes.body;
        if (
          lingering &&
          !isHead &&
          !webRes.headers.has("content-length") &&
          !webRes.headers.has("transfer-encoding")
        ) {
          // The body was rejected before this response (the handler caught
          // the error and answered itself). The transport holds the end of
          // the response until the drain settles, so a chunked response
          // would lack its terminating chunk until the client had uploaded
          // the rest of its body or the idle cap had passed. With a
          // Content-Length the client has the whole response the moment its
          // bytes are written, as with the runtime's own 413.
          const read = await readBounded(
            body,
            LINGER_FRAMED_BODY_LIMIT,
            abort.signal,
          );
          if (abort.signal.aborted) {
            if ("rest" in read) await read.rest.cancel().catch(() => {});
            return 0;
          }
          if ("whole" in read) {
            outHeaders["content-length"] = String(read.whole.length);
            res.respond(webRes.status, outHeaders);
            if (!res.destroyed) res.end(read.whole);
            return webRes.status;
          }
          body = read.rest;
        }
        if (isHead) {
          // HEAD-derived responses: commit headers with no body.
          res.respond(webRes.status, outHeaders);
          if (!res.destroyed) res.end();
        } else {
          await streamApiResponse(
            body,
            webRes.status,
            outHeaders,
            secHeaders,
            res,
            abort,
            sink,
          );
        }
      } else {
        // As above: with no length the transport would frame even an empty
        // body as chunked and hold its end until the drain settles. (204 and
        // 304 carry no body framing at all.)
        if (
          lingering &&
          webRes.status !== 204 &&
          webRes.status !== 304 &&
          !webRes.headers.has("content-length")
        )
          outHeaders["content-length"] = "0";
        res.respond(webRes.status, outHeaders);
        if (!res.destroyed) res.end();
      }

      return webRes.status;
    } finally {
      sink.dispose();
    }
  }
}

export const apiRouteRegistry = new ApiRouteRegistry();
