import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

// ─── Hoisted mock factories ───────────────────────────────────────────────────

const { mockServer, mockCreateSecureServer, registeredShutdownFns, mockExecuteServerScripts } = vi.hoisted(() => {
  const mockServer = {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    listen: vi.fn().mockImplementation(
      (_port: number, hostnameOrCb: any, cb?: () => void) => {
        const callback = typeof hostnameOrCb === "function" ? hostnameOrCb : cb;
        callback?.();
      },
    ),
    close: vi.fn().mockImplementation((cb?: (err?: Error) => void) => { cb?.(); }),
  };
  const mockCreateSecureServer = vi.fn(() => mockServer);
  const registeredShutdownFns: Array<() => void | Promise<void>> = [];
  const mockExecuteServerScripts = vi.fn(async (html: string, ..._rest: unknown[]) => html);
  return { mockServer, mockCreateSecureServer, registeredShutdownFns, mockExecuteServerScripts };
});

vi.mock("node:http", () => ({
  default: {
    createServer: vi.fn(() => mockServer),
  },
}));

// ─── Mocks ───────────────────────────────────────────────────────────────────

vi.mock("node:http2", () => ({
  default: {
    createSecureServer: mockCreateSecureServer,
    constants: { NGHTTP2_INTERNAL_ERROR: 2 },
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("mock-cert")),
  access: vi.fn().mockResolvedValue(undefined), // certs exist by default
  stat: vi.fn().mockResolvedValue({ mtimeMs: 1_705_000_000_000, size: 1_024 }),
  // Streamed large-asset tier (prompt 140); configured per test.
  open: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: vi.fn((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, "", "");
  }),
  execFile: vi.fn((...args: any[]) => {
    const cb = args[args.length - 1];
    if (typeof cb === "function") cb(null, { stdout: "", stderr: "" });
  }),
}));

vi.mock("node:fs", () => ({
  createReadStream: vi.fn(),
  existsSync: vi.fn(() => false),
}));

vi.mock("./mem.js", () => ({
  mem: { getPage: vi.fn(), getPageExact: vi.fn(), trackOpenPage: vi.fn(), untrackOpenPage: vi.fn(), isBooting: false, setBootingDone: vi.fn() },
}));

vi.mock("./config.js", () => ({
  shouldLog: vi.fn(() => true),
  BascikConfig: {
    base: "/",
    http: {
      httpCache: false,
      tls: {
        enabled: true,
      },
      rateLimit: true,
      hostname: "localhost",
      port: 8443,
    },
    scripts: {
      timeout: 30000,
    },
    logging: {
      level: "info",
      requests: true,
    },
    isProdServer: false,
    directory: { pages: "src/pages", components: ["src/components"], out: "dist" },
  },
}));

vi.mock("./events.js", () => ({
  eventEmitter: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  registerShutdownHandler: vi.fn((fn) => { registeredShutdownFns.push(fn); }),
  runShutdownHandlers: vi.fn(async () => {
    for (const fn of registeredShutdownFns) {
      await fn();
    }
  }),
}));

// The handler plans, then executes the plan (prompt 65). The mock keeps a
// single `executeServerScripts(html, request, timeout, filePath)` spy as the
// observation point so request-context assertions read naturally: the mocked
// planner records the html, and the mocked plan executor forwards to the spy.
vi.mock("./server-scripts.js", () => {
  return {
    executeServerScripts: mockExecuteServerScripts,
    // The plan is stored on the page (prompt 67); makePage builds a stub plan
    // carrying the html so the executor can forward it to the spy.
    executeServerScriptPlan: vi.fn(
      async (plan: any, request: unknown, context: unknown, timeout: number, filePath: string) =>
        Buffer.from(await mockExecuteServerScripts(plan.__html, request, context, timeout, filePath)),
    ),
    streamServerScripts: vi.fn(),
    DEFAULT_SCRIPT_TIMEOUT_MS: 5000,
  };
});

vi.mock("./paths.js", () => ({
  // Faithful port of the real getHttpPath so is404Page logic is genuinely
  // exercised: pages/404.html → /404, pages/blog/index.html → /blog/.
  getHttpPath: vi.fn((p: string) =>
    p.replace(/^pages/, "").replace(/\.html$/, "").replace(/\/index$/, "/")
  ),
}));

vi.mock("./mime.js", () => ({
  MIME_MAP: new Map([
    [".css", "text/css; charset=utf-8"],
    [".js", "application/javascript; charset=utf-8"],
    [".png", "image/png"],
  ]),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import { startHttp2Server } from "./http2.ts";
import { resetActiveRateLimiter, resetSseManager, startServerInstance } from "./server.ts";
import { mem } from "./mem.ts";
import { BascikConfig } from "./config.ts";
import { createReadStream } from "node:fs";
import { stat, readFile, access, open } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import { MAX_BUFFERED_ASSET_BYTES, getOpenStreamedAssetHandles } from "./caching.ts";
import { exec, execFile } from "node:child_process";
import { eventEmitter } from "./events.ts";

const mockMem = mem as unknown as {
  getPage: ReturnType<typeof vi.fn>;
  getPageExact: ReturnType<typeof vi.fn>;
  trackOpenPage: ReturnType<typeof vi.fn>;
  untrackOpenPage: ReturnType<typeof vi.fn>;
  isBooting: boolean;
  setBootingDone: ReturnType<typeof vi.fn>;
};
const mockCreateReadStream = createReadStream as unknown as ReturnType<typeof vi.fn>;
const mockStat = stat as unknown as ReturnType<typeof vi.fn>;
const mockOpen = open as unknown as ReturnType<typeof vi.fn>;
const mockReadFile = readFile as unknown as ReturnType<typeof vi.fn>;
const mockAccess = access as unknown as ReturnType<typeof vi.fn>;
const mockExec = exec as unknown as ReturnType<typeof vi.fn>;
const mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(async () => {
  mockStat.mockClear();
  mockOpen.mockReset();
  mockReadFile.mockClear();
  mockAccess.mockClear();
  mockExec.mockClear();
  mockExecFile.mockClear();
  mockCreateReadStream.mockClear();
  mockExecuteServerScripts.mockClear();
  mockServer.listen.mockClear();
  mockServer.close.mockClear();
  mockMem.getPage.mockClear();
  mockMem.getPageExact.mockClear();
  mockMem.trackOpenPage.mockClear();
  mockMem.untrackOpenPage.mockClear();
  mockMem.setBootingDone.mockClear();
  (eventEmitter.on as ReturnType<typeof vi.fn>).mockClear();
  (eventEmitter.removeListener as ReturnType<typeof vi.fn>).mockClear();
  registeredShutdownFns.length = 0;
  resetActiveRateLimiter();
  resetSseManager();
  (BascikConfig as any).isProdServer = false;
  mockMem.isBooting = false;
  // No exact-match pages by default: http2 falls back to mem.getPage (mocked per-test).
  mockMem.getPageExact.mockReturnValue(undefined);
  // Static asset ETags are cached module-globally by file path (prompt 39);
  // without clearing, a test that populates the cache for `/style.css`
  // leaks a stale entry into every later test using the same path.
  const { STATIC_CACHE_METADATA } = await import("./caching.ts");
  STATIC_CACHE_METADATA.clear();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeStream = () => ({
  respond: vi.fn(),
  end: vi.fn(),
  write: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
  destroyed: false,
  pipe: vi.fn(),
  session: { socket: { remoteAddress: "127.0.0.1" } },
});

const makeHeaders = (
  path?: string,
  method = "GET",
  acceptEncoding = "",
  referer?: string,
  extra: Record<string, string> = {},
) => ({
  ":path": path,
  ":method": method,
  "accept-encoding": acceptEncoding,
  referer,
  ...extra,
});

const getStreamHandler = () => {
  const call = mockServer.on.mock.calls.find((c: any[]) => c[0] === "stream");
  // If the server didn't register a stream listener, check if it's because TLS is disabled
  // and it registered a standard HTTP 'request' listener instead.
  if (!call) {
    const httpCall = mockServer.on.mock.calls.find((c: any[]) => c[0] === "request");
    if (httpCall) {
      // Return a wrapper that converts mockStream / mockHeaders into adapted HTTP objects
      return async (mockStream: any, mockHeaders: any) => {
        const reqMsg = {
          method: mockHeaders[":method"] ?? "GET",
          url: mockHeaders[":path"],
          headers: mockHeaders,
          socket: { remoteAddress: "127.0.0.1" },
        };
        const resMsg = {
          headersSent: false,
          destroyed: false,
          writeHead: vi.fn((status, headers) => {
            mockStream.respond({ ":status": status, ...headers });
          }),
          write: vi.fn((chunk) => mockStream.write(chunk)),
          end: vi.fn(function (chunk) {
            if (arguments.length === 0 || chunk === undefined) {
              mockStream.end(undefined);
            } else {
              mockStream.end(chunk);
            }
          }),
          destroy: vi.fn(),
          on: vi.fn((event, cb) => mockStream.on(event, cb)),
        };
        await httpCall[1](reqMsg, resMsg);
      };
    }
  }
  return call?.[1] as
    | ((stream: any, headers: any) => Promise<void>)
    | undefined;
};

/**
 * Returns a mock page suitable for most response tests. Pass
 * `hasServerScripts: true` to attach a stub `serverScriptPlan` built from the
 * page content (the executor mock forwards `__html` to the spy).
 */
const makePage = (overrides: Record<string, unknown> = {}) => {
  const { hasServerScripts, ...rest } = overrides as { hasServerScripts?: boolean } & Record<string, unknown>;
  const page: Record<string, unknown> = {
    relativePagePath: "pages/about.html",
    absolutePagePath: "/abs/pages/about.html",
    content: Buffer.from("<html>About</html>"),
    compressedContent: undefined as Buffer | undefined,
    usedComponentsSet: new Set<string>(),
    ...rest,
  };
  if (hasServerScripts) {
    const html = (page.content as Buffer).toString();
    page.serverScriptPlan = { segments: [{ kind: "static", bytes: Buffer.from(html) }], firstStreamIndex: -1, __html: html };
  }
  return page;
};

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────


export { describe, it, expect, vi, beforeEach, afterEach, createHash, mockServer, mockCreateSecureServer, registeredShutdownFns, mockExecuteServerScripts, startHttp2Server, resetActiveRateLimiter, resetSseManager, startServerInstance, mem, BascikConfig, createReadStream, stat, readFile, access, open, Readable, Writable, MAX_BUFFERED_ASSET_BYTES, getOpenStreamedAssetHandles, exec, execFile, eventEmitter, mockMem, mockCreateReadStream, mockStat, mockOpen, mockReadFile, mockAccess, mockExec, mockExecFile, makeStream, makeHeaders, getStreamHandler, makePage };

describe("startHttp2Server – stream handler", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("responds 405 for non-GET/HEAD methods", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "POST"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 405 }),
    );
    expect(stream.end).toHaveBeenCalledWith("Method Not Allowed");
  });

  it("responds 400 when path is missing", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders(undefined, "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 400 }),
    );
  });

  it("responds 404 for paths with dots in directory names but no file extension", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    // extname("/img.dir/dog") === "" (no ext on last segment) but split(".").length > 1
    await handler(stream, makeHeaders("/img.dir/dog", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
  });

  it("responds 404 when mem.getPage returns undefined", async () => {
    mockMem.getPage.mockReturnValue(undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/missing-page", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
  });

  it("responds 200 with page content when mem.getPage returns a page", async () => {
    const page = makePage({ content: Buffer.from("<html>About</html>") });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ":status": 200,
      }),
    );
    expect(stream.end).toHaveBeenCalledWith(page.content);
  });

  it("responds 404 with 404 page content when mem.getPage returns a 404 page", async () => {
    const page = makePage({
      relativePagePath: "pages/404.html",
      content: Buffer.from("<html>404 Not Found</html>"),
      compressedContent: Buffer.from("compressed"),
    });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/some-missing-page", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
    expect(stream.end).toHaveBeenCalledWith(page.content);
  });

  it("sends brotli-compressed content when client accepts br encoding", async () => {
    const page = makePage({
      content: Buffer.from("<html>Home</html>"),
      compressedContent: Buffer.from("br-compressed"),
    });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/", "GET", "br, gzip"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "content-encoding": "br" }),
    );
    expect(stream.end).toHaveBeenCalledWith(page.compressedContent);
  });

  it("falls back to uncompressed content when background brotli compression hasn't finished yet", async () => {
    const page = makePage({
      content: Buffer.from("<html>Home</html>"),
      compressedContent: undefined,
    });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/", "GET", "br, gzip"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.not.objectContaining({ "content-encoding": "br" }),
    );
    expect(stream.end).toHaveBeenCalledWith(page.content);
  });

  describe("gzip fallback for legacy clients that do not accept br", () => {
    it("serves the gzip body with content-encoding: gzip and a gzip-suffixed etag", async () => {
      const { BascikConfig } = await import("./config.ts");
      (BascikConfig as any).http.httpCache = true;
      const page = makePage({
        content: Buffer.from("<html>Home</html>"),
        compressedContent: Buffer.from("br-compressed"),
        gzipContent: Buffer.from("gzip-compressed"),
        etag: '"abc"',
      });
      mockMem.getPage.mockReturnValue(page);
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(stream, makeHeaders("/", "GET", "gzip, deflate"));
      expect(stream.respond).toHaveBeenCalledWith(
        expect.objectContaining({
          "content-encoding": "gzip",
          "content-length": (page.gzipContent as Buffer).byteLength,
          etag: '"abc-gzip"',
          vary: "Accept-Encoding",
        }),
      );
      expect(stream.end).toHaveBeenCalledWith(page.gzipContent);
      (BascikConfig as any).http.httpCache = false;
    });

    it("still prefers br when the client accepts both br and gzip", async () => {
      const page = makePage({
        content: Buffer.from("<html>Home</html>"),
        compressedContent: Buffer.from("br-compressed"),
        gzipContent: Buffer.from("gzip-compressed"),
      });
      mockMem.getPage.mockReturnValue(page);
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(stream, makeHeaders("/", "GET", "gzip, br"));
      expect(stream.respond).toHaveBeenCalledWith(
        expect.objectContaining({ "content-encoding": "br" }),
      );
      expect(stream.end).toHaveBeenCalledWith(page.compressedContent);
    });

    it("falls through to gzip when the client accepts br but brotli has not finished compressing yet", async () => {
      const page = makePage({
        content: Buffer.from("<html>Home</html>"),
        compressedContent: undefined,
        gzipContent: Buffer.from("gzip-compressed"),
      });
      mockMem.getPage.mockReturnValue(page);
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(stream, makeHeaders("/", "GET", "br, gzip"));
      expect(stream.respond).toHaveBeenCalledWith(
        expect.objectContaining({ "content-encoding": "gzip" }),
      );
      expect(stream.end).toHaveBeenCalledWith(page.gzipContent);
    });

    it("serves identity when the client accepts gzip but gzip has not finished compressing yet", async () => {
      const page = makePage({
        content: Buffer.from("<html>Home</html>"),
        compressedContent: Buffer.from("br-compressed"),
        gzipContent: undefined,
      });
      mockMem.getPage.mockReturnValue(page);
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(stream, makeHeaders("/", "GET", "gzip"));
      const headers = stream.respond.mock.calls[0][0];
      expect(headers).not.toHaveProperty("content-encoding");
      expect(stream.end).toHaveBeenCalledWith(page.content);
    });

    it("never sends gzip to a client whose Accept-Encoding does not list it", async () => {
      const page = makePage({
        content: Buffer.from("<html>Home</html>"),
        compressedContent: Buffer.from("br-compressed"),
        gzipContent: Buffer.from("gzip-compressed"),
      });
      mockMem.getPage.mockReturnValue(page);
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(stream, makeHeaders("/", "GET", "deflate"));
      const headers = stream.respond.mock.calls[0][0];
      expect(headers).not.toHaveProperty("content-encoding");
      expect(stream.end).toHaveBeenCalledWith(page.content);
    });

    it("serves identity without compression when client specifies br;q=0, gzip;q=0", async () => {
      const page = makePage({
        content: Buffer.from("<html>Home</html>"),
        compressedContent: Buffer.from("br-compressed"),
        gzipContent: Buffer.from("gzip-compressed"),
      });
      mockMem.getPage.mockReturnValue(page);
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(stream, makeHeaders("/", "GET", "br;q=0, gzip;q=0"));
      const headers = stream.respond.mock.calls[0][0];
      expect(headers).not.toHaveProperty("content-encoding");
      expect(stream.end).toHaveBeenCalledWith(page.content);
    });

    it("respects quality weights when gzip has higher weight than br (br;q=0.5, gzip;q=0.9)", async () => {
      const page = makePage({
        content: Buffer.from("<html>Home</html>"),
        compressedContent: Buffer.from("br-compressed"),
        gzipContent: Buffer.from("gzip-compressed"),
      });
      mockMem.getPage.mockReturnValue(page);
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(stream, makeHeaders("/", "GET", "br;q=0.5, gzip;q=0.9"));
      expect(stream.respond).toHaveBeenCalledWith(
        expect.objectContaining({ "content-encoding": "gzip" }),
      );
      expect(stream.end).toHaveBeenCalledWith(page.gzipContent);
    });

    it("answers 304 for a gzip-suffixed If-None-Match from a gzip-only client", async () => {
      const { BascikConfig } = await import("./config.ts");
      (BascikConfig as any).http.httpCache = true;
      const page = makePage({
        content: Buffer.from("<html>Home</html>"),
        gzipContent: Buffer.from("gzip-compressed"),
        etag: '"abc"',
      });
      mockMem.getPage.mockReturnValue(page);
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(stream, makeHeaders("/", "GET", "gzip", undefined, { "if-none-match": '"abc-gzip"' }));
      expect(stream.respond).toHaveBeenCalledWith(
        expect.objectContaining({ ":status": 304, etag: '"abc-gzip"' }),
      );
      expect(stream.end).toHaveBeenCalledWith();
      (BascikConfig as any).http.httpCache = false;
    });
  });

  it("sets no-cache headers when BascikConfig.http.httpCache is false", async () => {
    const page = makePage({ content: Buffer.from("<html></html>") });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        "cache-control": expect.stringContaining("no-store"),
      }),
    );
  });

  it("serves static asset bytes from the immutable representation", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.compression = false;
    mockStat.mockResolvedValueOnce({ mtimeMs: 1_705_000_000_000, size: 1_024 });
    const body = Buffer.from("body { color: red; }");
    mockReadFile.mockResolvedValueOnce(body);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    expect(mockStat).toHaveBeenCalled();
    // The response body and headers come from ONE representation read, not a
    // re-opened createReadStream (prompt 107).
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200, "content-length": body.byteLength }),
    );
    expect(stream.end).toHaveBeenCalledWith(body);
    (BascikConfig as any).http.compression = true;
  });

  it("decodes URL-encoded spaces in static asset paths", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/my%20style.css", "GET"));
    expect(mockStat).toHaveBeenCalledWith(expect.stringContaining("my style.css"));
  });

  it("handles double-slash leading paths safely within dist", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("//assets/app.js", "GET"));
    expect(mockStat).toHaveBeenCalledWith(expect.stringContaining("assets/app.js"));
  });

  it("responds 400 Bad Request for malformed percent-encoded URIs", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/%ff", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 400 }),
    );
  });

  it("serves in-memory pages with dots in path like /v1.0/about", async () => {
    mockMem.getPageExact.mockImplementation((p: string) => {
      if (p === "/v1.0/about") {
        return { relativePagePath: "pages/v1.0/about.html", content: Buffer.from("<h1>v1.0</h1>") };
      }
      return undefined;
    });
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/v1.0/about", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
  });

  it("treats uppercase .HTML extensions like lowercase (no static-file lookup)", async () => {
    mockMem.getPage.mockReturnValue(undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/index.HTML", "GET"));
    // Must follow the same route as /index.html: rejected as a dot-path,
    // never stat()'d on disk as a static asset.
    expect(mockStat).not.toHaveBeenCalled();
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
  });

  it("resolves the MIME type for uppercase static asset extensions", async () => {
    mockStat.mockResolvedValueOnce({ mtimeMs: 1_705_000_000_000, size: 1_024 });
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/STYLE.CSS", "HEAD"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        "content-type": expect.stringContaining("text/css"),
      }),
    );
  });
});

describe("startHttp2Server – security headers", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  const EXPECTED_SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "cross-origin-opener-policy": "same-origin-allow-popups",
    "cross-origin-resource-policy": "cross-origin",
  };

  it("includes security headers on page responses", async () => {
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining(EXPECTED_SECURITY_HEADERS),
    );
  });

  it("includes security headers on 404 responses", async () => {
    mockMem.getPage.mockReturnValue(undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/missing", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining(EXPECTED_SECURITY_HEADERS),
    );
  });

  it("includes security headers on 405 responses", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "DELETE"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining(EXPECTED_SECURITY_HEADERS),
    );
  });

  it("includes security headers on static asset responses", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    const openCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open");
    openCall?.[1]?.();
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining(EXPECTED_SECURITY_HEADERS),
    );
  });

  it("includes Strict-Transport-Security header when request has :scheme https", async () => {
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET", "", undefined, { ":scheme": "https" }));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ...EXPECTED_SECURITY_HEADERS,
        "strict-transport-security": "max-age=31536000; includeSubDomains",
      }),
    );
  });

  it("does NOT include Strict-Transport-Security on x-forwarded-proto https when trustProxy is false", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.trustProxy = false;
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET", "", undefined, { "x-forwarded-proto": "https" }));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.not.objectContaining({
        "strict-transport-security": expect.any(String),
      }),
    );
  });

  it("includes Strict-Transport-Security on x-forwarded-proto https when trustProxy is true", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.trustProxy = true;
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET", "", undefined, { "x-forwarded-proto": "https" }));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ...EXPECTED_SECURITY_HEADERS,
        "strict-transport-security": "max-age=31536000; includeSubDomains",
      }),
    );
    (BascikConfig as any).http.trustProxy = false;
  });

  it("includes Strict-Transport-Security when rightmost x-forwarded-proto is https in multi-value header", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.trustProxy = true;
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET", "", undefined, { "x-forwarded-proto": "http, https" }));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ...EXPECTED_SECURITY_HEADERS,
        "strict-transport-security": "max-age=31536000; includeSubDomains",
      }),
    );
    (BascikConfig as any).http.trustProxy = false;
  });

  it("does NOT include Strict-Transport-Security when rightmost x-forwarded-proto is http in multi-value header", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.trustProxy = true;
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET", "", undefined, { "x-forwarded-proto": "https, http" }));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.not.objectContaining({
        "strict-transport-security": expect.any(String),
      }),
    );
    (BascikConfig as any).http.trustProxy = false;
  });
});

describe("startHttp2Server – HEAD method", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("responds 200 for HEAD on a page without a body", async () => {
    mockMem.getPage.mockReturnValue(makePage({ content: Buffer.from("<html>Hi</html>") }));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "HEAD"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
    // HEAD must not send a body
    expect(stream.end).toHaveBeenCalledWith();
  });

  it("includes Content-Length in HEAD response", async () => {
    const content = Buffer.from("<html>Hello</html>");
    mockMem.getPage.mockReturnValue(makePage({ content }));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "HEAD"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "content-length": content.byteLength }),
    );
  });

  it("responds 200 for HEAD on a static asset without creating a read stream body", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn(), destroy: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "HEAD"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
    expect(fakeFileStream.pipe).not.toHaveBeenCalled();
    expect(stream.end).toHaveBeenCalledWith();
  });
});

describe("startHttp2Server – Content-Length and Vary", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("sets content-length equal to buffer byte length for uncompressed pages", async () => {
    const content = Buffer.from("<html>Hello world</html>");
    mockMem.getPage.mockReturnValue(makePage({ content }));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "content-length": content.byteLength }),
    );
  });

  it("sets content-length to compressed size when sending brotli", async () => {
    const compressed = Buffer.from("br-data");
    mockMem.getPage.mockReturnValue(
      makePage({ content: Buffer.from("<html>Hi</html>"), compressedContent: compressed }),
    );
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/", "GET", "br"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "content-length": compressed.byteLength }),
    );
  });

  it("sets Vary: Accept-Encoding on page responses", async () => {
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "vary": "Accept-Encoding" }),
    );
  });

  it("sets content-length on static asset responses from the representation bytes", async () => {
    const body = Buffer.from("a".repeat(64));
    mockReadFile.mockResolvedValueOnce(body);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "content-length": body.byteLength }),
    );
  });
});

describe("startHttp2Server – path traversal protection", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("returns 400 for a path traversal attempt in a static asset URL", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    // Extension present → goes through static asset branch; /../../../ escapes dist/
    await handler(stream, makeHeaders("/../../../etc/shadow.cfg", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 400 }),
    );
    expect(stream.end).toHaveBeenCalledWith("Bad Request");
  });

  it.each(["/.env", "/.git/config", "/foo/.hidden", "/%2Egit/config"])(
    "returns 404 for dot-segment path %s before filesystem access",
    async (path) => {
      const handler = getStreamHandler()!;
      const stream = makeStream();

      await handler(stream, makeHeaders(path, "GET"));

      expect(stream.respond).toHaveBeenCalledWith(
        expect.objectContaining({ ":status": 404 }),
      );
      expect(stream.end).toHaveBeenCalledWith("Not Found");
      expect(mockStat).not.toHaveBeenCalled();
    },
  );

  it("serves a file whose name contains literal %2F without escaping (not a traversal)", async () => {
    // path.resolve treats %2F as a literal character, not a /; the guard passes
    // and stat is called. Mock stat succeeds, then createReadStream is set up.
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.compression = false;
    mockStat.mockResolvedValueOnce({ mtimeMs: 1_705_000_000_000, size: 1_024 });
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/safe%2Ffile.txt", "GET"));
    // Guard passes (stays inside dist/). stat succeeds. Response is set up.
    expect(mockStat).toHaveBeenCalled();
    // Trigger open to send headers
    const openCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open");
    openCall?.[1]?.();
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
    (BascikConfig as any).http.compression = true;
  });
});

describe("startHttp2Server – base path routing", () => {
  beforeEach(async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).base = "/sub/";
    await startHttp2Server();
  });

  afterEach(async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).base = "/";
  });

  it.each([
    ["/sub/about", "/about"],
    ["/%73ub/about", "/about"],
    ["/sub/", "/"],
    ["/sub/index.html", "/"],
  ])("serves %s from the base-relative route %s", async (requestPath, lookupPath) => {
    const page = makePage();
    mockMem.getPageExact.mockImplementation((path) => path === lookupPath ? page : undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();

    await handler(stream, makeHeaders(requestPath));

    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 200 }));
    expect(mockMem.getPageExact).toHaveBeenCalledWith(lookupPath);
  });

  it("returns 404 for a request outside the configured base", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about"));
    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 404 }));
    expect(mockMem.getPage).not.toHaveBeenCalled();
  });

  it("serves a static asset under the configured base", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/sub/logo.png"));
    expect(mockStat).toHaveBeenCalledWith(expect.stringMatching(/dist\/logo\.png$/));
  });

  it("rejects traversal before stripping the configured base", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/sub/../../etc/passwd"));
    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 400 }));
    expect(mockMem.getPage).not.toHaveBeenCalled();
  });

  it("rejects dot segments before stripping the configured base", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/sub/.env"));
    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 404 }));
    expect(mockStat).not.toHaveBeenCalled();
  });

  it("accepts the live-reload endpoint and tracks a base-relative referer", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders("/sub/bascik-live-reload", "GET", "", "https://localhost:8443/sub/about"),
    );
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "content-type": "text/event-stream" }),
    );
    expect(mockMem.trackOpenPage).toHaveBeenCalledWith("/about");
  });

  it("serves a boot page whose live-reload client uses the configured base", async () => {
    mockMem.isBooting = true;
    const handler = getStreamHandler()!;
    const stream = makeStream();
    try {
      await handler(stream, makeHeaders("/sub/pending"));
      expect(String(stream.end.mock.calls[0][0])).toContain(
        'new EventSource("/sub/bascik-live-reload?boot=1")',
      );
    } finally {
      mockMem.isBooting = false;
    }
  });

  it("keeps root-base routing unchanged", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).base = "/";
    const page = makePage();
    mockMem.getPageExact.mockImplementation((path) => path === "/about" ? page : undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about"));
    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 200 }));
  });
});

describe("onError and server resiliency edge cases", () => {
  it("ignores network reset errors in onError", async () => {
    const { onError, isNetworkResetError } = await import("./server.ts");
    expect(isNetworkResetError({ code: "ECONNRESET" })).toBe(true);
    expect(isNetworkResetError({ code: "EPIPE" })).toBe(true);
    expect(isNetworkResetError({ code: "ECANCELED" })).toBe(true);
    expect(isNetworkResetError({ code: "ERR_HTTP2_STREAM_CANCEL" })).toBe(true);
    expect(isNetworkResetError({ code: "ERR_HTTP2_INVALID_STREAM" })).toBe(true);
    expect(isNetworkResetError({ code: "500_INTERNAL" })).toBe(false);

    const mockRes: any = {
      headersSent: false,
      destroyed: false,
      respond: vi.fn(),
      end: vi.fn(),
    };
    const netErr = new Error("Connection reset");
    (netErr as any).code = "ECONNRESET";
    onError(netErr, mockRes);

    expect(mockRes.respond).not.toHaveBeenCalled();
    expect(mockRes.end).not.toHaveBeenCalled();
  });

  it("responds 404 for ENOENT and 500 for generic error in onError", async () => {
    const { onError } = await import("./server.ts");
    const mockRes1: any = {
      headersSent: false,
      respond: vi.fn(),
      end: vi.fn(),
    };
    const enoentErr = new Error("File missing");
    (enoentErr as any).code = "ENOENT";
    onError(enoentErr, mockRes1);
    expect(mockRes1.respond).toHaveBeenCalledWith(404, expect.any(Object));

    const mockRes2: any = {
      headersSent: false,
      respond: vi.fn(),
      end: vi.fn(),
    };
    onError(new Error("Database crash"), mockRes2);
    expect(mockRes2.respond).toHaveBeenCalledWith(500, expect.any(Object));
  });

  it("handles exceptions thrown during res.respond in onError safely", async () => {
    const { onError } = await import("./server.ts");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => { });
    const mockRes: any = {
      headersSent: false,
      respond: vi.fn().mockImplementation(() => { throw new Error("Stream destroyed"); }),
      end: vi.fn().mockImplementation(() => { throw new Error("End destroyed"); }),
    };
    onError(new Error("Fail"), mockRes);

    expect(consoleSpy).toHaveBeenCalledWith("Error responding to stream/request:", expect.any(Error));
    expect(consoleSpy).toHaveBeenCalledWith("Error ending stream/request:", expect.any(Error));
  });

  it("returns 400 for malformed percent encoding in request path", async () => {
    await startHttp2Server();
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/%FF%FF", "GET"));

    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 400 }));
    expect(stream.end).toHaveBeenCalledWith("Bad Request");
  });

  it("responds 404 when a static asset vanishes after stat (deletion after selection)", async () => {
    await startHttp2Server();
    // stat succeeds (file present), but the byte read fails because the file
    // was removed between selection and acquisition. The representation owner
    // returns null and the handler 404s rather than serving a partial or
    // mismatched representation (prompt 107).
    mockStat.mockResolvedValueOnce({ mtimeMs: 1_705_000_000_000, size: 1_024 });
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
    expect(stream.end).toHaveBeenCalledWith("Not Found");
  });

  it("startServer boots HTTP/1.1 server when enableTls is false and HTTP/2 server when enableTls is true", async () => {
    const { startServer } = await import("./server.ts");
    const { BascikConfig } = await import("./config.ts");

    // HTTP/1.1 mode
    (BascikConfig as any).http.tls = { enabled: false };
    const http1Origin = await startServer();
    expect(http1Origin).toBeDefined();

    // HTTP/2 TLS mode
    (BascikConfig as any).http.tls = { enabled: true };
    const http2Origin = await startServer();
    expect(http2Origin).toBeDefined();
  });

  it("executes server scripts and sets private, no-store cache-control header", async () => {
    const { executeServerScripts } = await import("./server-scripts.ts");
    const mockExecute = executeServerScripts as unknown as ReturnType<typeof vi.fn>;
    mockExecute.mockResolvedValueOnce("<p>Server Script Result</p>");

    const page = makePage({
      content: Buffer.from("<script data-bascik-server>1</script>"),
      hasServerScripts: true,
    });
    mockMem.getPage.mockReturnValue(page);

    await startHttp2Server();
    const handler = getStreamHandler()!;
    const stream = makeStream();

    await handler(
      stream,
      makeHeaders("/dashboard?user=alice&tab=overview", "GET", "", undefined, {
        ":authority": "localhost:8443",
        ":scheme": "https",
        "cookie": "session=abc12345",
        "x-custom-header": "test-val",
      }),
    );

    expect(mockExecute).toHaveBeenCalledWith(
      "<script data-bascik-server>1</script>",
      expect.any(Request),
      { remoteIp: "127.0.0.1", platform: { name: "node" } },
      30000,
      "/abs/pages/about.html",
    );

    const webReq = mockExecute.mock.calls[0][1] as Request;
    expect(webReq.url).toBe("https://localhost:8443/dashboard?user=alice&tab=overview");
    expect(webReq.method).toBe("GET");
    expect(webReq.headers.get("cookie")).toBe("session=abc12345");
    expect(webReq.headers.get("x-custom-header")).toBe("test-val");

    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ":status": 200,
        "cache-control": "private, no-store",
      }),
    );
    expect(stream.end).toHaveBeenCalledWith(Buffer.from("<p>Server Script Result</p>"));
  });

  it("returns 404 for /bascik-live-reload when isProdServer is true", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = true;

    await startHttp2Server();
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET"));

    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
    expect(stream.end).toHaveBeenCalled();

    (BascikConfig as any).isProdServer = false;
  });

  it("does not deliver a static body to a destroyed response stream", async () => {
    await startHttp2Server();
    mockReadFile.mockResolvedValueOnce(Buffer.from("body { }"));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    (stream as any).destroyed = true;

    await handler(stream, makeHeaders("/style.css", "GET"));
    // A destroyed client stream never receives the body chunk.
    expect(stream.end).not.toHaveBeenCalledWith(Buffer.from("body { }"));
  });

  it("responds 404 when the representation read fails (owner maps read failure to not-found)", async () => {
    await startHttp2Server();
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("EACCES"), { code: "EACCES" }));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));

    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ":status": 404,
        "x-content-type-options": "nosniff",
      }),
    );
  });

  it("untracks open page when SSE live-reload stream closes", async () => {
    await startHttp2Server();
    const handler = getStreamHandler()!;
    const stream = makeStream();

    let closeCallback: (() => void) | undefined;
    (stream as any).on = vi.fn().mockImplementation((event: string, cb: any) => {
      if (event === "close") closeCallback = cb;
      return stream;
    });

    await handler(
      stream,
      makeHeaders("/bascik-live-reload", "GET", "", "http://localhost:8443/about"),
    );

    expect(mockMem.trackOpenPage).toHaveBeenCalledWith("/about");
    expect(closeCallback).toBeDefined();

    closeCallback!();
    expect(mockMem.untrackOpenPage).toHaveBeenCalledWith("/about");
  });

  it("serves boot page when server is booting and page is not yet stored", async () => {
    mockMem.isBooting = true;
    mockMem.getPage.mockReturnValue(undefined);

    await startHttp2Server();
    const handler = getStreamHandler()!;
    const stream = makeStream();

    await handler(stream, makeHeaders("/slow-page", "GET"));

    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ":status": 200,
        "content-type": expect.stringContaining("text/html"),
      }),
    );
    expect(stream.end).toHaveBeenCalledWith(expect.any(Buffer));
    const sentBuf = stream.end.mock.calls[0][0] as Buffer;
    expect(sentBuf.toString("utf8")).toContain("Building site");

    mockMem.isBooting = false;
  });
});

describe("startHttp2Server – onError: stream already has headers sent", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("skips respond() when headersSent is true (headers already sent before exception)", async () => {
    const page = makePage({ content: Buffer.from("<html>Hi</html>") });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    // First respond() call sets headersSent=true; stream.end() then throws,
    // causing the outer catch to invoke onError(), which must not call respond() again.
    stream.respond.mockImplementationOnce(() => {
      (stream as any).headersSent = true;
    });
    stream.end.mockImplementationOnce(() => { throw new Error("stream destroyed"); });
    await handler(stream, makeHeaders("/about", "GET"));
    // Only one respond() call (the page response); onError() must not add a second.
    expect(stream.respond).toHaveBeenCalledTimes(1);
  });

  it("responds 500 when stat throws a non-ENOENT error", async () => {
    const handler = getStreamHandler()!;
    mockStat.mockRejectedValueOnce(Object.assign(new Error("EPERM"), { code: "EPERM" }));
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 500 }),
    );
    expect(stream.end).toHaveBeenCalledWith("Internal Server Error");
  });
});

describe("startHttp2Server – logAccess skip conditions", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => { });
    await startHttp2Server();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("does not log access for the live-reload SSE path", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    const accessLines = consoleSpy.mock.calls.filter(
      (c: unknown[]) => String(c[0]).includes("bascik-live-reload"),
    );
    expect(accessLines).toHaveLength(0);
  });

  it("logs access for ordinary page requests (logging.requests defaults to true)", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).logging = { level: "info", requests: true };
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    const accessLines = consoleSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("GET") && String(c[0]).includes("/about"),
    );
    expect(accessLines.length).toBeGreaterThan(0);
  });

  it("skips logging when logging.requests is false", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).logging = { level: "info", requests: false };
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    const accessLines = consoleSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("GET") && String(c[0]).includes("/about"),
    );
    expect(accessLines).toHaveLength(0);
    (BascikConfig as any).logging = { level: "info", requests: true };
  });

  it("uses logging config when isProdServer is true", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = true;
    (BascikConfig as any).logging = { level: "info", requests: true };
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    const accessLines = consoleSpy.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("GET"),
    );
    expect(accessLines.length).toBeGreaterThan(0);
    (BascikConfig as any).isProdServer = false;
  });
});

describe("startHttp2Server – query string and trailing-slash routing", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("strips query string before looking up a page (path?q=1 → path)", async () => {
    const page = makePage({ relativePagePath: "pages/about.html" });
    mockMem.getPageExact.mockImplementation((p: string) =>
      p === "/about" ? page : undefined,
    );
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about?ref=nav", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
  });

  it("strips fragment/hash before looking up a page (path#section → path)", async () => {
    const page = makePage({ relativePagePath: "pages/about.html" });
    mockMem.getPage.mockReturnValue(undefined);
    mockMem.getPageExact.mockImplementation((p: string) =>
      p === "/about" ? page : undefined,
    );
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about#section", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
  });

  it("looks up trailing-slash variant when exact path has no match", async () => {
    const page = makePage({ relativePagePath: "pages/blog/index.html" });
    // Exact match for "/blog" fails, but "/blog/" succeeds
    mockMem.getPageExact.mockImplementation((p: string) =>
      p === "/blog/" ? page : undefined,
    );
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/blog", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
  });

  it("looks up path without trailing slash when trailing-slash path has no match", async () => {
    const page = makePage({ relativePagePath: "pages/about.html" });
    mockMem.getPageExact.mockImplementation((p: string) =>
      p === "/about" ? page : undefined,
    );
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about/", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
  });
});

describe("startHttp2Server – port bind: non-EADDRINUSE error rejects", () => {
  afterEach(() => {
    mockServer.listen.mockImplementation(
      (_port: number, _hostname: string, cb?: () => void) => { cb?.(); },
    );
  });

  it("rejects the promise when the server emits a non-EADDRINUSE error on listen", async () => {
    mockServer.listen.mockImplementation(
      (_port: number, _hostname: string, _cb?: () => void) => {
        const [, errorHandler] = mockServer.once.mock.calls.at(-1) as [
          string,
          (err: NodeJS.ErrnoException) => void,
        ];
        const err = Object.assign(new Error("EACCES"), { code: "EACCES" });
        errorHandler(err);
      },
    );
    await expect(startHttp2Server()).rejects.toThrow("EACCES");
  });
});

describe("startHttp2Server – server-scripts execution", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("calls executeServerScripts and serves the result for pages with hasServerScripts=true", async () => {
    const { executeServerScripts } = await import("./server-scripts.ts");
    const mockExecute = executeServerScripts as ReturnType<typeof vi.fn>;
    mockExecute.mockResolvedValueOnce("<p>Hello World</p>");

    const page = makePage({
      hasServerScripts: true,
      content: Buffer.from("<p>Hello {{name}}</p>"),
    });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/greeting", "GET"));
    expect(mockExecute).toHaveBeenCalled();
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "cache-control": "private, no-store" }),
    );
  });

  it("passes query params, path, and request headers to executeServerScripts", async () => {
    const { executeServerScripts } = await import("./server-scripts.ts");
    const mockExecute = executeServerScripts as ReturnType<typeof vi.fn>;
    mockExecute.mockResolvedValueOnce("<p>ok</p>");

    const page = makePage({ hasServerScripts: true, content: Buffer.from("ok") });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/greeting?color=blue", "GET", "", undefined, { "x-test": "val" }));
    const [, req] = mockExecute.mock.calls[0] as [string, Request];
    expect(new URL(req.url).pathname).toBe("/greeting");
    expect(new URL(req.url).searchParams.get("color")).toBe("blue");
    expect(req.headers.get("x-test")).toBe("val");
  });

  it("returns HEAD with no body for server-script pages", async () => {
    const { executeServerScripts } = await import("./server-scripts.ts");
    const mockExecute = executeServerScripts as ReturnType<typeof vi.fn>;
    mockExecute.mockResolvedValueOnce("<html>ok</html>");

    const page = makePage({ hasServerScripts: true, content: Buffer.from("ok") });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/greeting", "HEAD"));
    expect(stream.end).toHaveBeenCalledWith();
  });
});

describe("startHttp2Server – boot page", () => {
  beforeEach(async () => {
    mockMem.isBooting = true;
    await startHttp2Server();
  });

  afterEach(() => {
    mockMem.isBooting = false;
  });

  it("serves the boot page with status 200 when isBooting is true and page is not yet in mem", async () => {
    mockMem.getPage.mockReturnValue(undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }),
    );
    const body = stream.end.mock.calls[0]?.[0];
    expect(body?.toString()).toContain("Building site");
  });

  it("serves the boot page even when /404 page is already in memory if requested page is not yet in mem", async () => {
    mockMem.isBooting = true;
    mockMem.getPageExact.mockReturnValue(undefined);
    // Simulate /404 page being in memory during cold boot
    mockMem.getPage.mockReturnValue(makePage({ relativePagePath: "pages/404.html", content: Buffer.from("<html>404 Page</html>") }));
    const handler = getStreamHandler()!;
    for (const path of ["/", "/getting-started", "/index.html", "/about"]) {
      const stream = makeStream();
      await handler(stream, makeHeaders(path, "GET"));
      expect(stream.respond).toHaveBeenCalledWith(
        expect.objectContaining({ ":status": 200, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }),
      );
      const body = stream.end.mock.calls[0]?.[0];
      expect(body?.toString()).toContain("Building site");
    }
  });

  it("resolves /index.html to index page stored at / in mem", async () => {
    mockMem.isBooting = false;
    const indexPage = makePage({ relativePagePath: "pages/index.html", content: Buffer.from("<html>Home</html>") });
    mockMem.getPageExact.mockImplementation((p: string) => (p === "/" ? indexPage : undefined));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/index.html", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
    expect(stream.end).toHaveBeenCalledWith(indexPage.content);
  });

  it("serves the real page (not the boot page) when the page is already in mem", async () => {
    const page = makePage({ content: Buffer.from("<html>Ready</html>") });
    mockMem.getPageExact.mockReturnValue(page);
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    expect(stream.end).toHaveBeenCalledWith(page.content);
  });

  it("serves a 404 (not the boot page) when isBooting is false and page is missing", async () => {
    mockMem.isBooting = false;
    mockMem.getPage.mockReturnValue(undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/missing", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
    expect(stream.end).toHaveBeenCalledWith("Not Found");
  });

  it("serves a 404 (not the boot page) in --server mode even when isBooting is true", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = true;
    mockMem.getPage.mockReturnValue(undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
    (BascikConfig as any).isProdServer = false;
  });

  it("sends no body for HEAD requests to the boot page", async () => {
    mockMem.getPage.mockReturnValue(undefined);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "HEAD"));
    expect(stream.end).toHaveBeenCalledWith();
  });
});

describe("startHttp2Server – onError suppresses ERR_HTTP2_INVALID_STREAM", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await startHttp2Server();
    consoleSpy = vi.spyOn(console, "error").mockImplementation(() => { });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it("does not log or respond when ERR_HTTP2_INVALID_STREAM is caught (client disconnected mid-request)", async () => {
    consoleSpy.mockClear();
    const page = makePage({ content: Buffer.from("<html>Hi</html>") });
    mockMem.getPage.mockReturnValue(page);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    // Simulate stream.respond() throwing ERR_HTTP2_INVALID_STREAM (client disconnected
    // between the await stat() / await executeServerScripts() and the respond() call).
    const invalidStreamErr = Object.assign(new Error("invalid stream"), { code: "ERR_HTTP2_INVALID_STREAM" });
    stream.respond.mockImplementationOnce(() => { throw invalidStreamErr; });
    await handler(stream, makeHeaders("/about", "GET"));
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});
