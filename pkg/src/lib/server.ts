import { stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Server as NetServer } from "node:net";
import { mem } from "./mem.ts";
import { BascikConfig, shouldLog } from "./config.ts";
import { eventEmitter, runShutdownHandlers } from "./events.ts";
import { getHttpPath } from "./paths.ts";
import { MIME_MAP } from "./mime.ts";
import { executeServerScripts, DEFAULT_SCRIPT_TIMEOUT_MS } from "./server-scripts.ts";
import { getBootPageHtml } from "./boot-page.ts";
import { formatDuration } from "./format.ts";
import { stripBasePath, withBasePath } from "./base-path.ts";
import {
  getContentHashEtag,
  getEncodedEtag,
  resolveCacheControl,
  negotiateCompression,
  isCompressibleMime,
  STATIC_CACHE_METADATA,
  COMPRESSION_MIN_BYTES,
} from "./caching.ts";
import { readFile } from "node:fs/promises";
import zlib from "node:zlib";

import { makeEtag } from "./names.ts";

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
      // Skip noisy SSE keep-alive pings
      if (path?.split(/[?#]/)[0] === withBasePath("/bascik-live-reload", BascikConfig.base)) return;
      console.log(`${method} ${path} ${responseStatus} ${formatDuration(elapsed)}`);
    };

    try {
      // ── Rate limiting ────────────────────────────────────────────────────
      if (BascikConfig.isProdServer && BascikConfig.http.rateLimit !== false && isRateLimited(req.remoteIp)) {
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

      if (pathname.split("/").some((segment) => segment.startsWith("."))) {
        responseStatus = 404;
        res.respond(404, { ...secHeaders });
        res.end("Not Found");
        return;
      }

      const baseRelativePathname = stripBasePath(pathname, BascikConfig.base);
      if (baseRelativePathname === null) {
        responseStatus = 404;
        res.respond(404, { ...secHeaders });
        res.end("Not Found");
        return;
      }
      pathname = baseRelativePathname;

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

        let cached = STATIC_CACHE_METADATA.get(fullPath);
        if (!cached || cached.mtimeMs !== fileStat.mtimeMs || cached.size !== fileStat.size) {
          const fallbackEtag = `"${fileStat.mtimeMs}-${fileStat.size}"`;
          cached = {
            etag: fallbackEtag,
            size: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
          };
          STATIC_CACHE_METADATA.set(fullPath, cached);
          // Async background update with real content hash
          readFile(fullPath).then((rawContent) => {
            if (rawContent && Buffer.isBuffer(rawContent) && rawContent.length > 0) {
              const contentEtag = getContentHashEtag(rawContent);
              STATIC_CACHE_METADATA.set(fullPath, {
                etag: contentEtag,
                size: fileStat.size,
                mtimeMs: fileStat.mtimeMs,
              });
            }
          }).catch(() => { });
        }

        const rawEtag = cached.etag;
        const mimeType = MIME_MAP.get(ext.toLowerCase()) ?? "application/octet-stream";
        const cacheControlVal = BascikConfig.http.httpCache !== false
          ? resolveCacheControl(ext.toLowerCase(), BascikConfig.http.cacheControl)
          : "no-store";

        const enableCompression = BascikConfig.http.compression !== false && isCompressibleMime(mimeType, ext.toLowerCase()) && fileStat.size >= COMPRESSION_MIN_BYTES;
        const negotiatedEncoding = enableCompression ? negotiateCompression(req.headers["accept-encoding"]) : "identity";
        const effectiveEtag = negotiatedEncoding !== "identity" ? getEncodedEtag(rawEtag, negotiatedEncoding) : rawEtag;

        // Conditional GET (304)
        if (BascikConfig.http.httpCache !== false && (req.headers["if-none-match"] === effectiveEtag || req.headers["if-none-match"] === rawEtag)) {
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
          ...secHeaders,
        };

        if (BascikConfig.http.httpCache !== false) {
          staticHeaders["etag"] = effectiveEtag;
        }

        if (isHead) {
          responseStatus = 200;
          staticHeaders["content-length"] = fileStat.size;
          res.respond(200, staticHeaders);
          res.end();
          return;
        }

        // Check for pre-compressed sidecars (.br / .gz) or compress on the fly
        let sidecarBuffer: Buffer | undefined = undefined;
        let sidecarEncoding: string | undefined = undefined;

        if (negotiatedEncoding === "br") {
          try {
            const sidecar = await readFile(`${fullPath}.br`);
            if (sidecar && Buffer.isBuffer(sidecar) && sidecar.length > 0) {
              sidecarBuffer = sidecar;
              sidecarEncoding = "br";
            }
          } catch { }
        } else if (negotiatedEncoding === "gzip") {
          try {
            const sidecar = await readFile(`${fullPath}.gz`);
            if (sidecar && Buffer.isBuffer(sidecar) && sidecar.length > 0) {
              sidecarBuffer = sidecar;
              sidecarEncoding = "gzip";
            }
          } catch { }
        }

        if (sidecarBuffer && sidecarEncoding) {
          staticHeaders["content-encoding"] = sidecarEncoding;
          staticHeaders["content-length"] = sidecarBuffer.byteLength;
          responseStatus = 200;
          res.respond(200, staticHeaders);
          return res.end(sidecarBuffer);
        }

        if (enableCompression && (negotiatedEncoding === "br" || negotiatedEncoding === "gzip")) {
          try {
            const raw = await readFile(fullPath);
            if (raw && Buffer.isBuffer(raw) && raw.length > 0) {
              const compressed = negotiatedEncoding === "br"
                ? zlib.brotliCompressSync(raw)
                : zlib.gzipSync(raw);
              staticHeaders["content-encoding"] = negotiatedEncoding;
              staticHeaders["content-length"] = compressed.byteLength;
              responseStatus = 200;
              res.respond(200, staticHeaders);
              return res.end(compressed);
            }
          } catch { }
        }

        staticHeaders["content-length"] = fileStat.size;

        const fileStream = createReadStream(fullPath);

        fileStream.on("error", (err) => {
          if (res.destroyed) return;
          if (res.headersSent) {
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
            const relativeRefererPath = stripBasePath(rawPath, BascikConfig.base);
            if (relativeRefererPath !== null) openPagePath = getHttpPath(relativeRefererPath);
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
      // Try the literal path first, then normalizedPath (/index -> /), cleanPathname (stripping .html), and trailing-slash
      // toggle so that `/blog` and `/blog/` both resolve a page stored as `pages/blog/index.html`.
      const exactPage =
        mem.getPageExact(pathname) ??
        mem.getPageExact(normalizedPath) ??
        (cleanPathname !== pathname ? mem.getPageExact(cleanPathname) : undefined) ??
        mem.getPageExact(cleanPathname.endsWith("/") ? cleanPathname.slice(0, -1) : `${cleanPathname}/`);

      if (!exactPage && pathname.split(".").length > 1 && !/\.html?$/i.test(pathname)) {
        responseStatus = 404;
        res.respond(404, { ...secHeaders });
        return res.end();
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

      if (BascikConfig.http.httpCache === false) {
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
        }, BascikConfig.scripts.timeout ?? DEFAULT_SCRIPT_TIMEOUT_MS, page.absolutePagePath);
        const htmlBuf = Buffer.from(html);
        responseHeaders["cache-control"] = "private, no-store";
        responseHeaders["content-length"] = htmlBuf.byteLength;
        res.respond(responseStatus, responseHeaders);
        return res.end(isHead ? undefined : htmlBuf);
      }

      // ── ETag + conditional GET (skip for no-store pages) ─────────────────
      const rawAcceptEncoding = req.headers["accept-encoding"] ?? "";
      const acceptEncoding = Array.isArray(rawAcceptEncoding)
        ? rawAcceptEncoding.join(", ")
        : rawAcceptEncoding;
      const willCompressBr = /\bbr\b/.test(acceptEncoding) && !!page.compressedContent;

      const rawEtag = page.etag ?? makeEtag(page.content);
      const effectivePageEtag = willCompressBr ? getEncodedEtag(rawEtag, "br") : rawEtag;

      if (BascikConfig.http.httpCache !== false && (req.headers["if-none-match"] === effectivePageEtag || req.headers["if-none-match"] === rawEtag)) {
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

      // ── Brotli or uncompressed ────────────────────────────────────────────
      if (willCompressBr && page.compressedContent) {
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
  const hostname = BascikConfig.http.hostname ?? "localhost";
  const defaultPort = protocol === "https" ? 8443 : 8080;
  const envPortStr = process.env.BASCIK_SERVER_PORT || process.env.PORT;
  const envPort = envPortStr ? parseInt(envPortStr, 10) : undefined;
  const rawStartPort = (envPort && !isNaN(envPort)) ? envPort : (BascikConfig.http.port ?? defaultPort);
  const startPort = (!isNaN(rawStartPort) && rawStartPort > 0) ? rawStartPort : defaultPort;
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
  const enableTls = !!BascikConfig.http.tls?.enabled;
  if (enableTls) {
    const { createSelfSignedCert } = await import("./pki.ts");
    await createSelfSignedCert();
    const { startHttp2Server } = await import("./http2.ts");
    return startHttp2Server();
  }
  const { startHttpServer } = await import("./http.ts");
  return startHttpServer();
};
