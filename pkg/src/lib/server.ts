import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import http2 from "node:http2";
import { extname, resolve, sep } from "node:path";
import type { Server as NetServer } from "node:net";
import { mem } from "./mem.ts";
import { BascikConfig, shouldLog } from "./config.ts";
import { eventEmitter, registerShutdownHandler, runShutdownHandlers } from "./events.ts";
import { getHttpPath } from "./paths.ts";
import { MIME_MAP } from "./mime.ts";
import {
  DEFAULT_SCRIPT_TIMEOUT_MS,
  executeServerScriptPlan,
  streamServerScripts,
} from "./server-scripts.ts";
import { createResponseSink } from "./response-sink.ts";
import { getBootPageHtml } from "./boot-page.ts";
import { formatDuration } from "./format.ts";
import { stripBasePath, withBasePath } from "./base-path.ts";
import {
  getEncodedEtag,
  resolveCacheControl,
  negotiateCompression,
  matchesIfNoneMatch,
  getStaticDelivery,
  clearCompressedRepresentationCache,
  isCompressibleMime,
  COMPRESSION_MIN_BYTES,
  type StreamedStaticDelivery,
} from "./caching.ts";

import {
  RateLimiter,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_RATE_LIMIT_MAX,
} from "./rate-limit.ts";
import {
  setServerHealthState,
  getServerHealthState,
  isHealthEndpoint,
  handleHealthCheck,
  DEFAULT_DRAIN_TIMEOUT_MS,
  MAX_PORT_INCREMENTS,
  createGracefulShutdownHandler,
} from "./server-lifecycle.ts";
import { SseManager } from "./sse.ts";
import { apiRouteRegistry } from "./server-api.ts";
import { createWebRequest, requestOrigin } from "./api-runtime.ts";
import { NODE_PLATFORM } from "./request-execution.ts";

export { setServerHealthState, getServerHealthState, isHealthEndpoint, handleHealthCheck };

// ─── SSE live-reload manager ──────────────────────────────────────────────────
// Constructed lazily so its heartbeat timer is never created as an import-time
// side effect; the timer only starts once the dev server actually handles its
// first live-reload connection.
let activeSseManager: SseManager | null = null;

export const getSseManager = (): SseManager => {
  if (!activeSseManager) {
    activeSseManager = new SseManager();
  }
  return activeSseManager;
};

/** For testing or reconfiguration: reset the active SSE manager. */
export const resetSseManager = (): void => {
  if (activeSseManager) {
    activeSseManager.destroy();
    activeSseManager = null;
  }
};

import { makeEtag } from "./names.ts";

// ─── Security headers sent on every response ──────────────────────────────────
const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "cross-origin-opener-policy": "same-origin-allow-popups",
  "cross-origin-resource-policy": "cross-origin",
};

export const getSecurityHeaders = (req?: BascikRequest): Record<string, string> => {
  const isHttps = req && req.headers
    ? req.headers[":scheme"] === "https" ||
    (BascikConfig.http.trustProxy === true && req.headers["x-forwarded-proto"] === "https")
    : false;
  if (isHttps || (BascikConfig.isProdServer && BascikConfig.http.tls.enabled)) {
    return {
      ...SECURITY_HEADERS,
      "strict-transport-security": "max-age=31536000; includeSubDomains",
    };
  }
  return { ...SECURITY_HEADERS };
};

// Weak stat-based ETag for static files: no extra file read needed
export const makeStatEtag = (mtimeMs: number, size: number): string =>
  `W/"${mtimeMs.toString(36)}-${size.toString(36)}"`;

// ─── Per-IP rate limiting ─────────────────────────────────────────────────────
export const RATE_WINDOW_MS = DEFAULT_RATE_LIMIT_WINDOW_MS;
export const RATE_MAX_REQUESTS = DEFAULT_RATE_LIMIT_MAX;

let activeRateLimiter: RateLimiter | null = null;

export const getActiveRateLimiter = (): RateLimiter => {
  if (!activeRateLimiter) {
    const rateLimitConfig = BascikConfig.http.rateLimit;
    const windowMs = typeof rateLimitConfig === "object" && rateLimitConfig?.window
      ? rateLimitConfig.window
      : DEFAULT_RATE_LIMIT_WINDOW_MS;
    const max = typeof rateLimitConfig === "object" && rateLimitConfig?.max
      ? rateLimitConfig.max
      : DEFAULT_RATE_LIMIT_MAX;
    activeRateLimiter = new RateLimiter({ windowMs, max });
    activeRateLimiter.startSweep();
    registerShutdownHandler(() => {
      resetActiveRateLimiter();
      clearCompressedRepresentationCache();
    });
  }
  return activeRateLimiter;
};

/** For testing or reconfiguration: reset active rate limiter */
export const resetActiveRateLimiter = (): void => {
  if (activeRateLimiter) {
    activeRateLimiter.destroy();
    activeRateLimiter = null;
  }
  clearCompressedRepresentationCache();
};

export const isRateLimited = (ip: string): boolean => {
  return getActiveRateLimiter().isRateLimited(ip);
};

export interface BascikRequest {
  method: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  remoteIp: string;
  rawStream?: any;
}

export interface BascikResponse {
  headersSent: boolean;
  destroyed: boolean;
  writable: NodeJS.WritableStream;
  respond(status: number, headers: Record<string, string | number>): void;
  write(chunk: string | Buffer): boolean;
  end(chunk?: string | Buffer): void;
  close(code?: number): void;
  on(event: "close" | "drain" | "finish", cb: () => void): void;
  off(event: "close" | "drain" | "finish", cb: () => void): void;
}

export const isNetworkResetError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECANCELED" ||
    code === "ERR_HTTP2_STREAM_CANCEL" ||
    code === "ERR_HTTP2_INVALID_STREAM" ||
    code === "ERR_HTTP2_INVALID_SESSION" ||
    code === "ERR_STREAM_WRITE_AFTER_END" ||
    code === "ERR_STREAM_DESTROYED" ||
    code === "ERR_STREAM_ALREADY_FINISHED"
  );
};

const DEFAULT_500_BODY = Buffer.from(
  "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"utf-8\"><title>500 Internal Server Error</title></head><body><h1>Internal Server Error</h1></body></html>",
  "utf8"
);

export const onError = (error: unknown, res: BascikResponse, req?: BascikRequest): void => {
  // Client disconnected mid-request: not a server bug, nothing to respond to.
  if (isNetworkResetError(error)) return;
  const secHeaders = getSecurityHeaders(req);

  try {
    if (!res.headersSent) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        res.respond(404, { ...secHeaders });
        res.end();
      } else {
        // Try serving custom 500 page from memory store
        let custom500Page: any = undefined;
        try {
          custom500Page = mem.getPageExact("/500");
        } catch {
          // Guard against recursion if lookup throws
        }

        const bodyBuf = custom500Page?.content ? custom500Page.content : DEFAULT_500_BODY;
        res.respond(500, {
          "content-type": "text/html; charset=utf-8",
          "content-length": bodyBuf.byteLength,
          ...secHeaders,
        });
        res.end(bodyBuf);
      }
    }
  } catch (respondErr) {
    console.error("Error responding to stream/request:", respondErr);
    try {
      if (!res.headersSent) {
        res.respond(500, { "content-type": "text/html; charset=utf-8", ...secHeaders });
      }
      res.end(DEFAULT_500_BODY);
    } catch (endErr) {
      console.error("Error ending stream/request:", endErr);
    }
  }

  console.error("Request/Stream error:", error);
};

/**
 * The peer went away while a committed body was in flight: not a server
 * fault. Decided from the error code only, never from `res.destroyed`, because
 * `pipeline` destroys the transport on a read failure too and that must still
 * surface as an error.
 */
const isPeerAbort = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return (
    isNetworkResetError(err) ||
    code === "ERR_STREAM_PREMATURE_CLOSE" ||
    code === "ERR_STREAM_UNABLE_TO_PIPE"
  );
};

interface StreamedAssetContext {
  req: BascikRequest;
  res: BascikResponse;
  isHead: boolean;
  mimeType: string;
  cacheControlVal: string;
  secHeaders: Record<string, string>;
}

/**
 * Access-log status for a response whose peer went away (before or after
 * headers). Nginx's convention; it never reaches the wire.
 */
const STATUS_CLIENT_CLOSED = 499;

/**
 * Deliver a large static asset from one opened file handle (prompt 140).
 *
 * Contract:
 * - Headers carry the weak validator and `content-length` from the handle's
 *   own `fstat`, so validator and framing describe the streamed inode.
 * - `HEAD` and a matching weak `If-None-Match` are answered before any read
 *   stream exists; the handle is closed immediately.
 * - The body is `fd.createReadStream({ start: 0, end: size - 1 })` piped
 *   through `pipeline`, so socket backpressure governs reads, memory stays at
 *   the stream high-water mark, and the read is clamped to the advertised
 *   `content-length`. A file that grows under the open handle therefore never
 *   pushes bytes past the framing (which would poison an HTTP/1.1 keep-alive
 *   connection). A file that shrinks yields fewer bytes than advertised: that
 *   is detected by comparing `bytesRead` with `size` and treated as a
 *   server-side truncation.
 * - A read error before headers is a 500. A read error or truncation after
 *   headers destroys the transport (mirrors prompt 110: a committed response
 *   is never silently completed as a short body). On HTTP/2 the stream is
 *   closed with `NGHTTP2_INTERNAL_ERROR` so the peer sees a server fault,
 *   not a cancel.
 * - The handle closes on every path: success, error, and client abort. The
 *   read stream is created with `autoClose: false` so the delivery owns the
 *   single close, and `pipeline` destroys the read side on either end failing.
 * - Every failure is logged at most once, here, and never rethrown: the
 *   returned status is the single record for the access log (499 when the
 *   peer went away, 500 for a server-side fault after headers).
 *
 * Returns the status for access logging.
 */
const serveStreamedAsset = async (
  delivery: StreamedStaticDelivery,
  ctx: StreamedAssetContext,
): Promise<number> => {
  const { req, res, isHead, mimeType, cacheControlVal, secHeaders } = ctx;
  const httpCache = BascikConfig.http.httpCache !== false;
  try {
    if (res.destroyed) {
      return STATUS_CLIENT_CLOSED;
    }

    if (httpCache && matchesIfNoneMatch(req.headers["if-none-match"], delivery.etag)) {
      res.respond(304, {
        etag: delivery.etag,
        "cache-control": cacheControlVal,
        vary: "Accept-Encoding",
        ...secHeaders,
      });
      res.end();
      return 304;
    }

    const headers: Record<string, string | number> = {
      "content-type": mimeType,
      "cache-control": cacheControlVal,
      vary: "Accept-Encoding",
      "content-length": delivery.size,
      ...secHeaders,
    };
    if (httpCache) {
      headers["etag"] = delivery.etag;
    }

    if (isHead) {
      res.respond(200, headers);
      res.end();
      return 200;
    }

    // Own the read stream before committing headers so an open failure can
    // still become a clean 500 rather than a truncated 200. The read range is
    // clamped to the advertised length: EOF is not the framing, `size` is.
    const fileStream = delivery.fd.createReadStream({
      start: 0,
      end: delivery.size - 1,
      autoClose: false,
    });
    res.respond(200, headers);
    if (res.destroyed) {
      // The peer vanished as headers committed; nothing to write to.
      fileStream.destroy();
      return STATUS_CLIENT_CLOSED;
    }
    try {
      await pipeline(fileStream, res.writable);
    } catch (err) {
      // Headers are committed. A peer abort (reset, or the transport closing
      // under the pipeline) is not a server fault. Anything else must not
      // leave a short body that looks complete: destroy the transport so the
      // client sees a broken response, never a truncated 200.
      if (isPeerAbort(err)) return STATUS_CLIENT_CLOSED;
      console.error("[bascik] streamed asset read failed after headers:", err);
      res.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      return 500;
    }
    if (fileStream.bytesRead !== delivery.size) {
      // The file shrank under the open handle: the read range ended early and
      // `pipeline` finished the transport with fewer bytes than advertised.
      // Destroy it so the client sees a broken response rather than a short
      // body it might treat as complete.
      console.error(
        `[bascik] streamed asset truncated after headers: ${req.path} advertised ${delivery.size} bytes, read ${fileStream.bytesRead}`,
      );
      res.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
      return 500;
    }
    return 200;
  } catch (err) {
    if (!res.headersSent && !res.destroyed) {
      res.respond(500, { "content-type": "text/plain; charset=utf-8", ...secHeaders });
      res.end("Internal Server Error");
      return 500;
    }
    if (isPeerAbort(err)) return STATUS_CLIENT_CLOSED;
    // Headers are committed (or the peer is gone) and this is not a peer
    // abort: log once here and make sure the transport is torn down.
    console.error("[bascik] streamed asset failed after headers:", err);
    if (!res.destroyed) res.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
    return 500;
  } finally {
    await delivery.close();
  }
};

export const createRequestHandler = () => {
  const distDir = resolve(BascikConfig.directory.out);

  return async (req: BascikRequest, res: BascikResponse) => {
    const start = performance.now();
    let responseStatus = 0;
    const secHeaders = getSecurityHeaders(req);

    const logAccess = () => {
      if (responseStatus === 0) return;
      const logging = BascikConfig.logging;
      if (logging.requests === false) return;
      if (!shouldLog(logging.level ?? "info", "info")) return;
      const elapsed = performance.now() - start;
      const method = req.method;
      const path = req.path;
      // Skip noisy SSE keep-alive pings and health checks
      const cleanPath = path?.split(/[?#]/)[0];
      if (cleanPath === withBasePath("/bascik-live-reload", BascikConfig.base)) return;
      if (isHealthEndpoint(cleanPath ?? "")) return;
      console.log(`${method} ${path} ${responseStatus} ${formatDuration(elapsed)}`);
    };

    try {
      if (!req.path) {
        responseStatus = 400;
        res.respond(400, { ...secHeaders });
        return res.end();
      }

      // Parse the request pathname once so routing decisions are never
      // confused by query strings or fragments (e.g. /style.css?v=1 or /about#section).
      const rawPathname = req.path.split(/[?#]/)[0];
      let pathname = rawPathname;
      try {
        pathname = decodeURIComponent(rawPathname);
      } catch {
        responseStatus = 400;
        res.respond(400, { "content-type": "text/plain; charset=utf-8", ...secHeaders });
        res.end("Bad Request");
        return;
      }

      // Gap 1: Null byte and control characters check
      if (pathname.includes("\0") || /[\r\n\t]/.test(pathname)) {
        responseStatus = 400;
        res.respond(400, { "content-type": "text/plain; charset=utf-8", ...secHeaders });
        res.end("Bad Request");
        return;
      }

      // ── Health endpoint check (/_health, /_health/ready, /_health/live) ─
      // Un-rate-limited, un-cached, and checked before other routing
      if (isHealthEndpoint(pathname)) {
        const isHead = req.method === "HEAD";
        if (req.method !== "GET" && !isHead) {
          responseStatus = 405;
          if (res.writable && typeof (res.writable as any).resume === "function") {
            try { (res.writable as any).resume(); } catch { }
          }
          res.respond(405, { "allow": "GET, HEAD", "content-type": "text/plain; charset=utf-8", ...secHeaders });
          res.end("Method Not Allowed");
          return;
        }
        const health = handleHealthCheck(pathname);
        responseStatus = health.status;
        res.respond(health.status, {
          ...health.headers,
          ...secHeaders,
        });
        return res.end(isHead ? undefined : health.body);
      }

      // ── Rate limiting ────────────────────────────────────────────────────
      if (BascikConfig.isProdServer && BascikConfig.http.rateLimit !== false && isRateLimited(req.remoteIp)) {
        responseStatus = 429;
        res.respond(429, { "retry-after": String(RATE_WINDOW_MS / 1000), "content-type": "text/plain; charset=utf-8", ...secHeaders });
        res.end("Too Many Requests");
        return;
      }

      // ── Path traversal guard for all requests ────────────────────────────
      if (
        pathname.includes("/../") ||
        pathname.startsWith("../") ||
        pathname.endsWith("/..") ||
        pathname === ".."
      ) {
        responseStatus = 400;
        res.respond(400, { "content-type": "text/plain; charset=utf-8", ...secHeaders });
        res.end("Bad Request");
        return;
      }

      if (pathname.split("/").some((segment) => segment.startsWith("."))) {
        responseStatus = 404;
        res.respond(404, { "content-type": "text/plain; charset=utf-8", ...secHeaders });
        res.end("Not Found");
        return;
      }

      const baseRelativePathname = stripBasePath(pathname, BascikConfig.base);
      if (baseRelativePathname === null) {
        responseStatus = 404;
        res.respond(404, { "content-type": "text/plain; charset=utf-8", ...secHeaders });
        res.end("Not Found");
        return;
      }

      // ── API route matching and dispatch ──────────────────────────────────
      // Runs before the GET/HEAD method guard so POST, PUT, DELETE, etc. work.
      const apiMatch = apiRouteRegistry.match(pathname);
      if (apiMatch) {
        responseStatus = await apiRouteRegistry.dispatch(req, res, apiMatch, secHeaders);
        return;
      }

      pathname = baseRelativePathname;

      // ── Method guard: GET and HEAD only ──────────────────────────────────
      const isHead = req.method === "HEAD";
      if (req.method !== "GET" && !isHead) {
        responseStatus = 405;
        if (res.writable && typeof (res.writable as any).resume === "function") {
          try { (res.writable as any).resume(); } catch { }
        }
        res.respond(405, { "allow": "GET, HEAD", "content-type": "text/plain; charset=utf-8", ...secHeaders });
        res.end("Method Not Allowed");
        return;
      }

      // ── Static asset (has extension, not .html) ──────────────────────────
      const ext = extname(pathname).toLowerCase();
      if (ext && !ext.match(/^\.htm.*$/)) {
        // Path traversal guard: resolved path must stay inside dist/
        const safePath = pathname.replace(/^\/+/, ""); // strip leading slashes
        const fullPath = resolve(distDir, safePath);
        if (!fullPath.startsWith(distDir + sep)) {
          responseStatus = 400;
          res.respond(400, { ...secHeaders });
          res.end("Bad Request");
          return;
        }

        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
          fileStat = await stat(fullPath);
        } catch (err) {
          responseStatus = (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
          res.respond(responseStatus, { ...secHeaders });
          res.end(responseStatus === 404 ? "Not Found" : "Internal Server Error");
          return;
        }

        const mimeType = MIME_MAP.get(ext.toLowerCase()) ?? "application/octet-stream";
        const cacheControlVal = BascikConfig.http.httpCache !== false
          ? resolveCacheControl(ext.toLowerCase(), BascikConfig.http.cacheControl)
          : "no-store";

        // Negotiate the representation before validators, headers, or body so
        // every field describes the one selected representation (prompt 95).
        const enableCompression = BascikConfig.http.compression !== false && isCompressibleMime(mimeType, ext.toLowerCase()) && fileStat.size >= COMPRESSION_MIN_BYTES;
        const negotiatedEncoding = enableCompression ? negotiateCompression(req.headers["accept-encoding"]) : "identity";

        // Acquire the selected delivery as one owner (prompt 140). At or under
        // MAX_BUFFERED_ASSET_BYTES this is the prompt 107 immutable
        // representation (`fileStat` is only a cache-invalidation hint; `etag`,
        // `size`, and `buffer` all derive from the same bytes delivered). Above
        // it the file is opened once and streamed with a weak validator taken
        // from that handle's own stat.
        const delivery = await getStaticDelivery(fullPath, negotiatedEncoding, fileStat);

        if (!delivery) {
          if (res.destroyed) return;
          responseStatus = 404;
          res.respond(404, { ...secHeaders });
          res.end("Not Found");
          return;
        }

        if (delivery.kind === "streamed") {
          responseStatus = await serveStreamedAsset(delivery, {
            req,
            res,
            isHead,
            mimeType,
            cacheControlVal,
            secHeaders,
          });
          return;
        }

        const representation = delivery.representation;
        const rawEtag = representation.rawEtag;
        const effectiveEtag = representation.etag;

        // Conditional GET (304)
        if (BascikConfig.http.httpCache !== false && matchesIfNoneMatch(req.headers["if-none-match"], effectiveEtag, rawEtag)) {
          responseStatus = 304;
          const headers304: Record<string, string | number> = {
            etag: effectiveEtag,
            "cache-control": cacheControlVal,
            "vary": "Accept-Encoding",
            ...secHeaders,
          };
          res.respond(304, headers304);
          res.end();
          return;
        }

        const staticHeaders: Record<string, string | number> = {
          "content-type": mimeType,
          "cache-control": cacheControlVal,
          "vary": "Accept-Encoding",
          "content-length": representation.size,
          ...secHeaders,
        };

        if (BascikConfig.http.httpCache !== false) {
          staticHeaders["etag"] = effectiveEtag;
        }

        if (representation.encoding !== "identity" && effectiveEtag !== rawEtag) {
          staticHeaders["content-encoding"] = representation.encoding;
        }

        // The client may have disconnected while the representation was
        // acquired; never commit headers or a body to a destroyed stream.
        if (res.destroyed) {
          return;
        }

        responseStatus = 200;
        res.respond(200, staticHeaders);
        return res.end(isHead ? undefined : representation.buffer);
      }

      // Normalize pathname for page lookup (e.g. /about.html -> /about, /index.html -> /)
      const cleanPathname = pathname.replace(/\.html$/i, "");
      const normalizedPath = cleanPathname === "/index" ? "/" : cleanPathname.replace(/\/index$/, "/");

      // ── Live-reload SSE ──────────────────────────────────────────────────
      if (pathname === "/bascik-live-reload") {
        // Disable in production serve mode.
        if (BascikConfig.isProdServer) {
          responseStatus = 404;
          res.respond(404, { ...secHeaders });
          return res.end();
        }

        const isHead = req.method === "HEAD";
        if (isHead) {
          responseStatus = 200;
          res.respond(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            ...secHeaders,
          });
          return res.end();
        }

        const isBootReloadConnection = new URL(req.path, "http://localhost").searchParams.get("boot") === "1";

        responseStatus = 200;
        res.respond(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          ...secHeaders,
        });

        // Parse the referer once at connection time for path-matching and open-page tracking.
        let openPagePath: string | null = null;
        try {
          if (req.headers.referer) {
            const rawPath = new URL(req.headers.referer as string).pathname;
            const relativeRefererPath = stripBasePath(rawPath, BascikConfig.base);
            if (relativeRefererPath !== null) openPagePath = getHttpPath(relativeRefererPath);
          }
        } catch { }
        if (openPagePath) mem.trackOpenPage(openPagePath);

        const sseManager = getSseManager();
        const client = sseManager.addClient(res, openPagePath);
        if (!client) {
          return;
        }

        const eventHandler = ({
          relativePagePath,
        }: {
          relativePagePath: string;
        }) => {
          if (res.destroyed) return;
          if (openPagePath) {
            const httpPath = getHttpPath(relativePagePath);
            // Normalize trailing slashes: browsers may omit the trailing slash on index routes.
            const strip = (p: string) => p.replace(/\/$/, "") || "/";
            if (strip(openPagePath) !== strip(httpPath)) return;
          }
          const gen = sseManager.getNextGeneration();
          sseManager.send(client, `data: reload ${gen}\n\n`);
        };

        const assetChangedHandler = () => {
          if (res.destroyed) return;
          const gen = sseManager.getNextGeneration();
          sseManager.send(client, `data: reload ${gen}\n\n`);
        };

        // Reload boot pages immediately when the initial scan finishes.
        const bootDoneHandler = () => {
          if (res.destroyed) return;
          const gen = sseManager.getNextGeneration();
          sseManager.send(client, `data: reload ${gen}\n\n`);
        };

        eventEmitter.on("transpiled", eventHandler);
        eventEmitter.on("asset-changed", assetChangedHandler);
        eventEmitter.on("boot-done", bootDoneHandler);

        res.on("close", () => {
          if (openPagePath) mem.untrackOpenPage(openPagePath);
          // The SseManager owns exactly one drain/close/broadcast subscription
          // per client and one global build-error subscription, so on close it
          // both removes this client's listeners and keeps open-page tracking
          // balanced. Only the reload listeners are per-connection here.
          sseManager.removeClient(client.id);
          eventEmitter.removeListener("transpiled", eventHandler);
          eventEmitter.removeListener("asset-changed", assetChangedHandler);
          eventEmitter.removeListener("boot-done", bootDoneHandler);
        });

        if (isBootReloadConnection && !mem.isBooting && !res.destroyed) {
          const gen = sseManager.getNextGeneration();
          sseManager.send(client, `data: reload ${gen}\n\n`);
        }
        return;
      }

      // ── In-memory page lookup ────────────────────────────────────────────
      // Try the literal path first, then normalizedPath (/index -> /), cleanPathname (stripping .html), and trailing-slash
      // toggle so that `/blog` and `/blog/` both resolve a page stored as `pages/blog/index.html`.
      const exactPage =
        mem.getPageExact(pathname) ??
        mem.getPageExact(normalizedPath) ??
        (cleanPathname !== pathname ? mem.getPageExact(cleanPathname) : undefined) ??
        mem.getPageExact(cleanPathname.endsWith("/") ? cleanPathname.slice(0, -1) : `${cleanPathname}/`);

      if (!exactPage && pathname.split(".").length > 1 && !/\.html?$/i.test(pathname)) {
        responseStatus = 404;
        res.respond(404, { "content-type": "text/plain; charset=utf-8", ...secHeaders });
        return res.end("Not Found");
      }

      // During the initial transpile in dev mode, serve a boot page instead of 404 for any page
      // that has not yet finished transpiling into memory.
      if (!exactPage && mem.isBooting && !BascikConfig.isProdServer) {
        responseStatus = 200;
        res.respond(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...secHeaders });
        const bootPage = getBootPageHtml(
          withBasePath("/bascik-live-reload?boot=1", BascikConfig.base),
        );
        return res.end(isHead ? undefined : bootPage);
      }

      const page = exactPage ?? mem.getPage(pathname);

      if (!page) {
        responseStatus = 404;
        res.respond(404, { "content-type": "text/plain; charset=utf-8", ...secHeaders });
        return res.end("Not Found");
      }

      // A page is the 404 page only when its resolved HTTP path is exactly
      // /404 (`pages/blog/404.html`, a page about 404s, must not match).
      const is404Page = getHttpPath(page.relativePagePath) === "/404";

      responseStatus = is404Page ? 404 : 200;

      const responseHeaders: Record<string, string | number> = {
        "content-type": "text/html; charset=utf-8",
        "vary": "Accept-Encoding",
        ...secHeaders,
      };

      if (BascikConfig.http.httpCache === false) {
        responseHeaders["cache-control"] =
          "no-store, no-cache, must-revalidate, proxy-revalidate";
        responseHeaders["pragma"] = "no-cache";
        responseHeaders["expires"] = "0";
      }

      // ── Pages with server scripts: generated fresh each request ──────────
      // Server-script output is personalized per-request; always prevent caching.
      if (page.serverScriptPlan) {
        // A planner error recorded at store time (conflicting directives,
        // unresolvable sidecar id) is this page's 500; headers are not sent yet.
        if ("error" in page.serverScriptPlan) throw page.serverScriptPlan.error;
        const plan = page.serverScriptPlan;
        const request = createWebRequest(req, requestOrigin(req));
        const context = { remoteIp: req.remoteIp, platform: NODE_PLATFORM };
        const timeout = BascikConfig.scripts.timeout ?? DEFAULT_SCRIPT_TIMEOUT_MS;
        responseHeaders["cache-control"] = "private, no-store";
        // The plan was built at store time (prompt 67): no regex scan and no
        // page.content.toString() on the request path.

        if (plan.firstStreamIndex === -1 || isHead) {
          // No `stream` scripts (or HEAD): today's buffered path, byte for byte.
          // HEAD keeps this path so it can report content-length with no body,
          // matching the static-file HEAD branch.
          const htmlBuf = await executeServerScriptPlan(plan, request, context, timeout, page.absolutePagePath);
          responseHeaders["content-length"] = htmlBuf.byteLength;
          res.respond(responseStatus, responseHeaders);
          return res.end(isHead ? undefined : htmlBuf);
        }

        // Early flush (prompt 65): phase one resolves every `server` job (a
        // throw here is still a 500), then headers commit with no
        // content-length, then static bytes and `stream` outputs flow in
        // document order. No etag, no content-encoding: the body is not a
        // known whole.
        // The sink honors backpressure (awaits `drain` after a false write)
        // and aborts every unfinished job when the client disconnects.
        const abort = new AbortController();
        const sink = createResponseSink(res, abort);
        try {
          const streamer = streamServerScripts(plan, request, context, timeout, page.absolutePagePath, sink, abort.signal);
          await streamer.ready;
          res.respond(responseStatus, responseHeaders);
          streamer.commit();
          try {
            await streamer.done;
          } catch (streamErr) {
            // Script failures are absorbed inside phase two; only transport
            // errors reach here. Headers are sent, so never respond again.
            if (!isNetworkResetError(streamErr)) {
              console.error("[bascik] streamed response failed after commit:", streamErr);
            }
            abort.abort();
          }
        } finally {
          sink.dispose();
        }
        if (!res.destroyed) res.end();
        return;
      }

      // ── ETag + conditional GET (skip for no-store pages) ─────────────────
      // Pick the best encoding the client accepts that is already computed:
      // br first, then gzip for legacy clients (or while brotli is still
      // compressing in the background), else identity.
      const availablePageEncodings: Array<"br" | "gzip"> = [];
      if (page.compressedContent) availablePageEncodings.push("br");
      if (page.gzipContent) availablePageEncodings.push("gzip");

      const pageEncoding = BascikConfig.http.compression !== false
        ? negotiateCompression(req.headers["accept-encoding"], availablePageEncodings)
        : "identity";

      const rawEtag = page.etag ?? makeEtag(page.content);
      const effectivePageEtag = pageEncoding === "identity" ? rawEtag : getEncodedEtag(rawEtag, pageEncoding);

      if (BascikConfig.http.httpCache !== false && matchesIfNoneMatch(req.headers["if-none-match"], effectivePageEtag, rawEtag)) {
        responseStatus = 304;
        res.respond(304, {
          etag: effectivePageEtag,
          "cache-control": responseHeaders["cache-control"] ?? "public, max-age=0, must-revalidate",
          "vary": "Accept-Encoding",
          ...secHeaders,
        });
        return res.end();
      }

      if (BascikConfig.http.httpCache !== false) {
        responseHeaders["etag"] = effectivePageEtag;
      }

      // ── Brotli, gzip fallback, or uncompressed ─────────────────────────────────────
      if (pageEncoding === "br" && page.compressedContent) {
        responseHeaders["content-encoding"] = "br";
        responseHeaders["content-length"] = page.compressedContent.byteLength;
        res.respond(responseStatus, responseHeaders);
        return res.end(isHead ? undefined : page.compressedContent);
      }
      if (pageEncoding === "gzip" && page.gzipContent) {
        responseHeaders["content-encoding"] = "gzip";
        responseHeaders["content-length"] = page.gzipContent.byteLength;
        res.respond(responseStatus, responseHeaders);
        return res.end(isHead ? undefined : page.gzipContent);
      }

      responseHeaders["content-length"] = page.content.byteLength;
      res.respond(responseStatus, responseHeaders);
      return res.end(isHead ? undefined : page.content);
    } catch (error) {
      onError(error, res, req);
    } finally {
      logAccess();
    }
  };
};

export const startServerInstance = async (
  server: NetServer,
  protocol: "http" | "https",
  onShutdown?: () => void,
  onForceClose?: () => void
): Promise<string> => {
  const hostname = BascikConfig.http.hostname ?? "localhost";
  const defaultPort = protocol === "https" ? 8443 : 8080;
  const envPortStr = process.env.BASCIK_SERVER_PORT || process.env.PORT;
  const envPort = envPortStr ? parseInt(envPortStr, 10) : undefined;
  const rawStartPort = (envPort && !isNaN(envPort)) ? envPort : (BascikConfig.http.port ?? defaultPort);
  const startPort = (!isNaN(rawStartPort) && rawStartPort > 0) ? rawStartPort : defaultPort;
  let origin = "";

  // Find the first available port, incrementing if the preferred one is in use.
  await new Promise<void>((resolve, reject) => {
    let attempts = 0;
    const tryPort = (p: number) => {
      if (p > 65535 || attempts >= MAX_PORT_INCREMENTS) {
        reject(new RangeError(`No available ports found between ${startPort} and ${Math.min(65535, startPort + MAX_PORT_INCREMENTS)}.`));
        return;
      }
      const errorHandler = (err: NodeJS.ErrnoException) => {
        server.removeListener("error", errorHandler);
        if (err.code === "EADDRINUSE") {
          if (BascikConfig.isProdServer) {
            reject(new Error(`Port ${p} is already in use. Under --server, specify a free port with --port or http.port.`));
            return;
          }
          attempts++;
          console.warn(`Port ${p} is in use, trying ${p + 1}…`);
          tryPort(p + 1);
        } else {
          reject(err);
        }
      };
      server.once("error", errorHandler);
      server.listen(p, hostname, () => {
        server.removeListener("error", errorHandler);
        origin = `${protocol}://${hostname}:${p}`;
        setServerHealthState("ready");
        resolve();
      });
    };
    tryPort(startPort);
  });

  // General runtime error handler
  server.on("error", (error) => console.error(error));

  // ── Graceful shutdown on SIGTERM / SIGINT ────────────────────────────────
  const drainTimeout = BascikConfig.http.timeouts?.drain ?? DEFAULT_DRAIN_TIMEOUT_MS;

  const gracefulShutdown = createGracefulShutdownHandler({
    server,
    drainTimeout,
    onShutdown,
    onForceClose,
    runShutdownHandlers,
  });

  process.setMaxListeners(process.getMaxListeners() + 2);
  const sigtermHandler = () => { void gracefulShutdown("SIGTERM"); };
  const sigintHandler = () => { void gracefulShutdown("SIGINT"); };
  process.once("SIGTERM", sigtermHandler);
  process.once("SIGINT", sigintHandler);

  server.once("close", () => {
    process.removeListener("SIGTERM", sigtermHandler);
    process.removeListener("SIGINT", sigintHandler);
    process.setMaxListeners(Math.max(0, process.getMaxListeners() - 2));
  });

  return origin;
};

export const startServer = async (): Promise<string> => {
  await apiRouteRegistry.init();
  const enableTls = !!BascikConfig.http.tls?.enabled;
  if (enableTls) {
    const { startHttp2Server } = await import("./http2.ts");
    return startHttp2Server();
  }
  const { startHttpServer } = await import("./http.ts");
  return startHttpServer();
};
