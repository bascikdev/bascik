import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Server as NetServer } from "node:net";
import { mem } from "./mem.js";
import { BascikConfig, shouldLog } from "./config.js";
import { eventEmitter, runShutdownHandlers } from "./events.js";
import { getHttpPath } from "./paths.js";
import { MIME_MAP } from "./mime.js";
import { executeServerScripts, DEFAULT_SCRIPT_TIMEOUT_MS } from "./server-scripts.js";
import { BOOT_PAGE_HTML } from "./boot-page.js";

import { makeEtag } from "./names.js";

export { makeEtag };

// ─── Security headers sent on every response ──────────────────────────────────
export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "SAMEORIGIN",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "interest-cohort=()",
};

export const getSecurityHeaders = (req?: BascikRequest): Record<string, string> => {
  const isHttps = req && req.headers
    ? req.headers[":scheme"] === "https" || req.headers["x-forwarded-proto"] === "https"
    : false;
  if (isHttps || (BascikConfig.isProdServer && BascikConfig.prodServer?.enableTls)) {
    return {
      ...SECURITY_HEADERS,
      "strict-transport-security": "max-age=31536000; includeSubDomains",
    };
  }
  return { ...SECURITY_HEADERS };
};

// Weak stat-based ETag for static files: no extra file read needed
export const makeStatEtag = (mtimeMs: number, size: number): string =>
  `W/"${mtimeMs.toString(36)}-${fileStatSizeToString(size)}"`;

// Keep formatting clean and fast
const fileStatSizeToString = (size: number): string => size.toString(36);

// ─── Per-IP rate limiting ─────────────────────────────────────────────────────
export const RATE_WINDOW_MS = 10_000;
export const RATE_MAX_REQUESTS = 500;

interface RateEntry { count: number; windowStart: number; }

/** Exported for test cleanup only, do not use in production code. */
export const _rateLimiter = new Map<string, RateEntry>();

export const isRateLimited = (ip: string): boolean => {
  const now = Date.now();
  const entry = _rateLimiter.get(ip);
  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    _rateLimiter.set(ip, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > RATE_MAX_REQUESTS;
};

// Purge stale entries to prevent unbounded memory growth.
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _rateLimiter) {
    if (now - entry.windowStart >= RATE_WINDOW_MS) _rateLimiter.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

export interface BascikRequest {
  method: string;
  path?: string;
  headers: Record<string, string | string[] | undefined>;
  remoteIp: string;
}

export interface BascikResponse {
  headersSent: boolean;
  destroyed: boolean;
  writable: NodeJS.WritableStream;
  respond(status: number, headers: Record<string, string | number>): void;
  write(chunk: string | Buffer): boolean;
  end(chunk?: string | Buffer): void;
  close(code?: number): void;
  on(event: "close", cb: () => void): void;
}

export const isNetworkResetError = (err: unknown): boolean => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return (
    code === "ECONNRESET" ||
    code === "EPIPE" ||
    code === "ECANCELED" ||
    code === "ERR_HTTP2_STREAM_CANCEL" ||
    code === "ERR_HTTP2_INVALID_STREAM"
  );
};

export const onError = (error: unknown, res: BascikResponse, req?: BascikRequest): void => {
  // Client disconnected mid-request: not a server bug, nothing to respond to.
  if (isNetworkResetError(error)) return;
  const secHeaders = getSecurityHeaders(req);
  try {
    if (!res.headersSent) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        res.respond(404, { ...secHeaders });
      } else {
        res.respond(500, { ...secHeaders });
      }
    }
  } catch (respondErr) {
    console.error("Error responding to stream/request:", respondErr);
  }

  try {
    res.end();
  } catch (endErr) {
    console.error("Error ending stream/request:", endErr);
  }

  console.error("Request/Stream error:", error);
};

export const createRequestHandler = () => {
  const distDir = resolve(process.cwd(), "dist");

  return async (req: BascikRequest, res: BascikResponse) => {
    const startMs = Date.now();
    let responseStatus = 0;
    const secHeaders = getSecurityHeaders(req);

    const logAccess = () => {
      if (responseStatus === 0) return;
      const logging = BascikConfig.isProdServer
        ? (BascikConfig.prodServer?.logging ?? { level: "info", requests: true })
        : (BascikConfig.devServer?.logging ?? { level: "info", requests: true });
      if (logging.requests === false) return;
      if (!shouldLog(logging.level ?? "info", "info")) return;
      const elapsed = Date.now() - startMs;
      const method = req.method;
      const path = req.path;
      // Skip noisy SSE keep-alive pings
      if (path === "/bascik-live-reload") return;
      console.log(`${method} ${path} ${responseStatus} ${elapsed}ms`);
    };

    try {
      // ── Rate limiting ────────────────────────────────────────────────────
      if (BascikConfig.isProdServer && BascikConfig.prodServer?.rateLimit !== false && isRateLimited(req.remoteIp)) {
        responseStatus = 429;
        res.respond(429, { "retry-after": String(RATE_WINDOW_MS / 1000), ...secHeaders });
        res.end("Too Many Requests");
        return;
      }

      // ── Method guard: GET and HEAD only ──────────────────────────────────
      const isHead = req.method === "HEAD";
      if (req.method !== "GET" && !isHead) {
        responseStatus = 405;
        res.respond(405, { "allow": "GET, HEAD", ...secHeaders });
        res.end("Method Not Allowed");
        return;
      }

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
        res.respond(400, { ...secHeaders });
        res.end("Bad Request");
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
        res.respond(400, { ...secHeaders });
        res.end("Bad Request");
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

        // Stat gives us size (for Content-Length) + mtime (for ETag) in one syscall.
        let fileStat: Awaited<ReturnType<typeof stat>>;
        try {
          fileStat = await stat(fullPath);
        } catch (err) {
          responseStatus = (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
          res.respond(responseStatus, { ...secHeaders });
          res.end(responseStatus === 404 ? "Not Found" : "Internal Server Error");
          return;
        }

        const etag = makeStatEtag(fileStat.mtimeMs, fileStat.size);
        if (BascikConfig.cacheHttp !== false && req.headers["if-none-match"] === etag) {
          responseStatus = 304;
          res.respond(304, { etag, ...secHeaders });
          res.end();
          return;
        }

        const staticHeaders: Record<string, string | number> = {
          "content-type": MIME_MAP.get(ext) ?? "application/octet-stream",
          "content-length": fileStat.size,
          ...secHeaders,
        };
        if (BascikConfig.cacheHttp !== false) {
          staticHeaders["etag"] = etag;
          staticHeaders["cache-control"] = "public, max-age=3600";
        } else {
          staticHeaders["cache-control"] = "no-store";
        }

        if (isHead) {
          responseStatus = 200;
          res.respond(200, staticHeaders);
          res.end();
          return;
        }

        const fileStream = createReadStream(fullPath);

        fileStream.on("error", (err) => {
          if (res.destroyed) return;
          if (res.headersSent) {
            // Headers already went out on "open", so a second respond() would
            // throw ERR_HTTP2_HEADERS_SENT. Abort the stream instead.
            res.close(2); // NGHTTP2_INTERNAL_ERROR equivalent
            return;
          }
          responseStatus = (err as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
          res.respond(responseStatus, { ...secHeaders });
          res.end(responseStatus === 404 ? "Not Found" : "Internal Server Error");
        });

        fileStream.on("open", () => {
          if (res.destroyed) { fileStream.destroy(); return; }
          responseStatus = 200;
          res.respond(200, staticHeaders);
          fileStream.pipe(res.writable);
        });

        return;
      }

      // Normalize pathname for page lookup (e.g. /about.html -> /about)
      const cleanPathname = pathname.replace(/\.html$/i, "");

      // ── Live-reload SSE ──────────────────────────────────────────────────
      if (pathname === "/bascik-live-reload") {
        // Disable in production serve mode.
        if (BascikConfig.isProdServer) {
          responseStatus = 404;
          res.respond(404, { ...secHeaders });
          return res.end();
        }

        const isBootReloadConnection = new URL(req.path, "http://localhost").searchParams.get("boot") === "1";

        responseStatus = 200;
        res.respond(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          ...secHeaders,
        });

        res.write(`data: connected\n\n`);

        // Parse the referer once at connection time for path-matching and open-page tracking.
        let openPagePath: string | null = null;
        try {
          if (req.headers.referer) {
            const rawPath = new URL(req.headers.referer as string).pathname;
            openPagePath = getHttpPath(rawPath);
          }
        } catch { }
        if (openPagePath) mem.trackOpenPage(openPagePath);

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
          res.write(`data: reload\n\n`);
        };

        const assetChangedHandler = () => {
          if (res.destroyed) return;
          res.write(`data: reload\n\n`);
        };

        // Reload boot pages immediately when the initial scan finishes.
        const bootDoneHandler = () => { if (res.destroyed) return; res.write(`data: reload\n\n`); };

        eventEmitter.on("transpiled", eventHandler);
        eventEmitter.on("asset-changed", assetChangedHandler);
        eventEmitter.on("boot-done", bootDoneHandler);

        if (isBootReloadConnection && !mem.isBooting && !res.destroyed) {
          res.write(`data: reload\n\n`);
        }

        res.on("close", () => {
          if (openPagePath) mem.untrackOpenPage(openPagePath);
          eventEmitter.removeListener("transpiled", eventHandler);
          eventEmitter.removeListener("asset-changed", assetChangedHandler);
          eventEmitter.removeListener("boot-done", bootDoneHandler);
        });
        return;
      }

      // ── In-memory page lookup ────────────────────────────────────────────
      // Try the literal path first, then cleanPathname (stripping .html), and trailing-slash
      // toggle so that `/blog` and `/blog/` both resolve a page stored as `pages/blog/index.html`.
      const exactPage =
        mem.getPageExact(pathname) ??
        (cleanPathname !== pathname ? mem.getPageExact(cleanPathname) : undefined) ??
        mem.getPageExact(cleanPathname.endsWith("/") ? cleanPathname.slice(0, -1) : `${cleanPathname}/`);

      if (!exactPage && pathname.split(".").length > 1) {
        responseStatus = 404;
        res.respond(404, { ...secHeaders });
        return res.end();
      }

      const page = exactPage ?? mem.getPage(pathname);

      if (!page) {
        // During the initial transpile, serve a boot page instead of 404.
        // The boot page connects to the SSE endpoint and reloads automatically
        // when its specific page is transpiled or when boot finishes entirely.
        if (mem.isBooting && !BascikConfig.isProdServer) {
          responseStatus = 200;
          res.respond(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...secHeaders });
          return res.end(isHead ? undefined : Buffer.from(BOOT_PAGE_HTML));
        }
        responseStatus = 404;
        res.respond(404, { ...secHeaders });
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

      if (BascikConfig.cacheHttp === false) {
        responseHeaders["cache-control"] =
          "no-store, no-cache, must-revalidate, proxy-revalidate";
        responseHeaders["pragma"] = "no-cache";
        responseHeaders["expires"] = "0";
      }

      // ── Pages with server scripts: generated fresh each request ──────────
      // Server-script output is personalized per-request; always prevent caching.
      if (page.hasServerScripts) {
        const qIdx = req.path.indexOf("?");
        const searchParams = Object.fromEntries(
          new URLSearchParams(qIdx === -1 ? "" : req.path.slice(qIdx + 1)),
        );
        const requestHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (k.startsWith(":")) continue; // skip HTTP/2 pseudo-headers
          requestHeaders[k] = Array.isArray(v) ? v.join(", ") : (v ?? "");
        }
        const html = await executeServerScripts(page.content.toString(), {
          path: pathname,
          method: req.method ?? "GET",
          headers: requestHeaders,
          searchParams,
        }, BascikConfig.prodServer?.scriptTimeout ?? DEFAULT_SCRIPT_TIMEOUT_MS, page.absolutePagePath);
        const htmlBuf = Buffer.from(html);
        responseHeaders["cache-control"] = "private, no-store";
        responseHeaders["content-length"] = htmlBuf.byteLength;
        res.respond(responseStatus, responseHeaders);
        return res.end(isHead ? undefined : htmlBuf);
      }

      // ── ETag + conditional GET (skip for no-store pages) ─────────────────
      const etag = page.etag ?? makeEtag(page.content);
      if (BascikConfig.cacheHttp !== false && req.headers["if-none-match"] === etag) {
        responseStatus = 304;
        res.respond(304, { etag, ...secHeaders });
        return res.end();
      }
      responseHeaders["etag"] = etag;

      // ── Brotli or uncompressed ────────────────────────────────────────────
      const rawAcceptEncoding = req.headers["accept-encoding"] ?? "";
      const acceptEncoding = Array.isArray(rawAcceptEncoding)
        ? rawAcceptEncoding.join(", ")
        : rawAcceptEncoding;

      if (/\bbr\b/.test(acceptEncoding) && page.compressedContent) {
        responseHeaders["content-encoding"] = "br";
        responseHeaders["content-length"] = page.compressedContent.byteLength;
        res.respond(responseStatus, responseHeaders);
        return res.end(isHead ? undefined : page.compressedContent);
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
  onShutdown?: () => void
): Promise<string> => {
  const hostname = BascikConfig.prodServer?.hostname ?? "localhost";
  const defaultPort = protocol === "https" ? 8443 : 8080;
  const startPort = BascikConfig.prodServer?.port ?? defaultPort;
  let origin = "";

  // Find the first available port, incrementing if the preferred one is in use.
  await new Promise<void>((resolve, reject) => {
    const tryPort = (p: number) => {
      if (p > 65535) {
        reject(new RangeError(`No available ports found between ${startPort} and 65535.`));
        return;
      }
      const errorHandler = (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
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
        resolve();
      });
    };
    tryPort(startPort);
  });

  // General runtime error handler
  server.on("error", (error) => console.error(error));

  // ── Graceful shutdown on SIGTERM / SIGINT ────────────────────────────────
  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\nReceived ${signal}, shutting down gracefully…`);

    if (onShutdown) {
      try {
        onShutdown();
      } catch { }
    }

    if (typeof (server as any).closeAllConnections === "function") {
      try {
        (server as any).closeAllConnections();
      } catch { }
    }

    // Close all registered handles (chokidar watchers, exec watchers).
    runShutdownHandlers().catch(() => { });

    server.close((err) => {
      if (err) console.error("Error closing server:", err);
      process.exit(0);
    });

    // Force exit if sessions or connections haven't drained within 10 s.
    setTimeout(() => {
      console.error("Graceful shutdown timeout: forcing exit");
      process.exit(1);
    }, 10_000).unref();
  };
  process.setMaxListeners(process.getMaxListeners() + 2);
  const sigtermHandler = () => gracefulShutdown("SIGTERM");
  const sigintHandler = () => gracefulShutdown("SIGINT");
  process.once("SIGTERM", sigtermHandler);
  process.once("SIGINT", sigintHandler);

  server.once("close", () => {
    process.removeListener("SIGTERM", sigtermHandler);
    process.removeListener("SIGINT", sigintHandler);
  });

  return origin;
};

export const startServer = async (): Promise<string> => {
  const enableTls = !!BascikConfig.prodServer?.enableTls;
  if (enableTls) {
    const { createSelfSignedCert } = await import("./pki.js");
    await createSelfSignedCert();
    const { startHttp2Server } = await import("./http2.js");
    return startHttp2Server();
  }
  const { startHttpServer } = await import("./http.js");
  return startHttpServer();
};
