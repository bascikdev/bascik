import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Hoisted mock factories ───────────────────────────────────────────────────

const { mockServer, mockCreateSecureServer } = vi.hoisted(() => {
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
  return { mockServer, mockCreateSecureServer };
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
    directory: { pages: "src/pages", components: "src/components", out: "dist" },
  },
}));

vi.mock("./events.js", () => ({
  eventEmitter: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  runShutdownHandlers: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./server-scripts.js", () => ({
  executeServerScripts: vi.fn(async (html: string) => html),
  DEFAULT_SCRIPT_TIMEOUT_MS: 5000,
}));

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
import { _rateLimiter, startServerInstance } from "./server.ts";
import { mem } from "./mem.ts";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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

// ─────────────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  _rateLimiter.clear();
  mockMem.isBooting = false;
  // No exact-match pages by default: http2 falls back to mem.getPage (mocked per-test).
  mockMem.getPageExact.mockReturnValue(undefined);
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

/** Returns a mock page suitable for most response tests. */
const makePage = (overrides: Record<string, unknown> = {}) => ({
  relativePagePath: "pages/about.html",
  absolutePagePath: "/abs/pages/about.html",
  content: Buffer.from("<html>About</html>"),
  compressedContent: undefined as Buffer | undefined,
  hasServerScripts: false,
  usedComponentsSet: new Set<string>(),
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – server setup", () => {
  it("creates a secure server with key and cert", async () => {
    await startHttp2Server();
    expect(mockCreateSecureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        key: expect.any(Buffer),
        cert: expect.any(Buffer),
      }),
    );
  });

  it("sets maxConcurrentStreams: 250 in HTTP/2 settings", async () => {
    await startHttp2Server();
    expect(mockCreateSecureServer).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ maxConcurrentStreams: 250 }),
      }),
    );
  });

  it("registers a stream event handler", async () => {
    await startHttp2Server();
    const registered = mockServer.on.mock.calls.map((c: any[]) => c[0]);
    expect(registered).toContain("stream");
  });

  it("calls server.listen", async () => {
    await startHttp2Server();
    expect(mockServer.listen).toHaveBeenCalledWith(
      8443,
      "localhost",
      expect.any(Function),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Stream handler – method/path validation
// ─────────────────────────────────────────────────────────────────────────────

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

  it("pipes a file stream for static asset requests", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.compression = false;
    mockStat.mockResolvedValueOnce({ mtimeMs: 1_705_000_000_000, size: 1_024 });
    const fakeFileStream = {
      on: vi.fn().mockReturnThis(),
      pipe: vi.fn(),
    };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    expect(mockStat).toHaveBeenCalled();
    expect(mockCreateReadStream).toHaveBeenCalled();
    // Trigger the open event to verify pipe is called
    const openCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open");
    openCall?.[1]?.();
    expect(fakeFileStream.pipe).toHaveBeenCalledWith(stream);
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

// ─────────────────────────────────────────────────────────────────────────────
// Security headers
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – security headers", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  const EXPECTED_SECURITY_HEADERS = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "SAMEORIGIN",
    "referrer-policy": "strict-origin-when-cross-origin",
    "permissions-policy": "interest-cohort=()",
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

  it("includes Strict-Transport-Security header when request has :scheme https or x-forwarded-proto https", async () => {
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
});

// ─────────────────────────────────────────────────────────────────────────────
// HEAD method
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Content-Length and Vary headers
// ─────────────────────────────────────────────────────────────────────────────

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

  it("sets content-length on static asset responses", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    const openCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open");
    openCall?.[1]?.();
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "content-length": 1_024 }), // from mockStat default
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ETag and 304 Not Modified
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – ETag and conditional GET", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("sets an ETag header on page responses", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.httpCache = true;
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ etag: expect.stringMatching(/^"[A-Za-z0-9_-]+"$/) }),
    );
    (BascikConfig as any).http.httpCache = false;
  });

  it("returns 304 when If-None-Match matches and cacheHttp is enabled", async () => {
    const { BascikConfig } = await import("./config.ts");
    // Temporarily set cacheHttp to true for this test
    (BascikConfig as any).http.httpCache = true;

    const page = makePage({ content: Buffer.from("<html>Cached</html>") });
    mockMem.getPage.mockReturnValue(page);

    // First request: get the ETag
    const handler = getStreamHandler()!;
    const stream1 = makeStream();
    await handler(stream1, makeHeaders("/about", "GET"));
    const respondCall = stream1.respond.mock.calls[0][0] as Record<string, unknown>;
    const etag = respondCall["etag"] as string;

    // Second request: conditional GET with matching ETag
    const stream2 = makeStream();
    await handler(stream2, makeHeaders("/about", "GET", "", undefined, { "if-none-match": etag }));
    expect(stream2.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 304 }),
    );
    expect(stream2.end).toHaveBeenCalledWith();

    (BascikConfig as any).http.httpCache = false;
  });

  it("does not return 304 when cacheHttp is false (no-store mode)", async () => {
    const page = makePage({ content: Buffer.from("<html>Cached</html>") });
    mockMem.getPage.mockReturnValue(page);

    const handler = getStreamHandler()!;
    // First request to capture ETag
    const stream1 = makeStream();
    await handler(stream1, makeHeaders("/about", "GET"));
    const respondCall = stream1.respond.mock.calls[0][0] as Record<string, unknown>;
    const etag = respondCall["etag"] as string;

    // Second request with matching ETag: should still return 200 because cacheHttp is false
    mockMem.getPage.mockReturnValue(page);
    const stream2 = makeStream();
    await handler(stream2, makeHeaders("/about", "GET", "", undefined, { "if-none-match": etag }));
    expect(stream2.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
  });

  it("sets an ETag header on static asset responses", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.httpCache = true;
    (BascikConfig as any).http.compression = false;
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    const openCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open");
    openCall?.[1]?.();
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ etag: expect.stringMatching(/^"[0-9a-f]{32,64}"$/) }),
    );
    (BascikConfig as any).http.httpCache = false;
    (BascikConfig as any).http.compression = true;
  });

  it("returns 304 for a static asset when If-None-Match matches", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.httpCache = true;
    // Stat returns deterministic values so the ETag is predictable
    const mtimeMs = 1_705_000_000_000;
    const size = 1_024;
    mockStat.mockResolvedValue({ mtimeMs, size });

    const handler = getStreamHandler()!;
    // First GET to read the ETag
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const stream1 = makeStream();
    await handler(stream1, makeHeaders("/style.css", "GET"));
    const openCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open");
    openCall?.[1]?.();
    const etag = (stream1.respond.mock.calls[0][0] as Record<string, unknown>)["etag"] as string;

    // Second GET with matching ETag → 304
    const stream2 = makeStream();
    await handler(stream2, makeHeaders("/style.css", "GET", "", undefined, { "if-none-match": etag }));
    expect(stream2.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 304 }),
    );
    expect(stream2.end).toHaveBeenCalledWith();
    (BascikConfig as any).cacheHttp = false;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Path traversal protection
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiting
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – rate limiting", () => {
  beforeEach(async () => {
    // Rate limiting is isProdServer-only; enable it for this suite.
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = true;
    await startHttp2Server();
  });

  afterEach(async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = false;
  });

  it("allows requests below the rate limit", async () => {
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/about", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
  });

  it("returns 429 when the per-IP request limit is exceeded", async () => {
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;

    // Flood with 501 requests from the same IP; the 501st must be throttled.
    const ip = "10.0.0.99";
    for (let i = 0; i < 501; i++) {
      const s = { ...makeStream(), session: { socket: { remoteAddress: ip } } };
      await handler(s, makeHeaders("/about", "GET"));
      if (i === 500) {
        expect(s.respond).toHaveBeenCalledWith(
          expect.objectContaining({ ":status": 429 }),
        );
      }
    }
  });

  it("does not throttle requests when rateLimit is disabled", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.rateLimit = false;
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;

    const ip = "10.0.0.100";
    for (let i = 0; i < 501; i++) {
      const s = { ...makeStream(), session: { socket: { remoteAddress: ip } } };
      await handler(s, makeHeaders("/about", "GET"));
      if (i === 500) {
        expect(s.respond).toHaveBeenCalledWith(
          expect.objectContaining({ ":status": 200 }),
        );
      }
    }
    (BascikConfig as any).http.rateLimit = true;
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

  it("closes stream with NGHTTP2_INTERNAL_ERROR if fileStream errors after headersSent", async () => {
    await startHttp2Server();
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn(), destroy: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);

    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));

    const errCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "error");
    const closeSpy = vi.fn();
    stream.close = closeSpy;
    (stream as any).headersSent = true;

    errCall?.[1]?.(new Error("Disk read error"));
    expect(closeSpy).toHaveBeenCalledWith(2);
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
      {
        path: "/dashboard",
        method: "GET",
        headers: expect.objectContaining({
          "cookie": "session=abc12345",
          "x-custom-header": "test-val",
        }),
        searchParams: { user: "alice", tab: "overview" },
      },
      expect.any(Number),
      "/abs/pages/about.html",
    );

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

  it("destroys fileStream on open if response stream was destroyed mid-request", async () => {
    await startHttp2Server();
    const fakeFileStream = {
      on: vi.fn().mockReturnThis(),
      pipe: vi.fn(),
      destroy: vi.fn(),
    };
    mockCreateReadStream.mockReturnValue(fakeFileStream);

    const handler = getStreamHandler()!;
    const stream = makeStream();
    (stream as any).destroyed = true;

    await handler(stream, makeHeaders("/style.css", "GET"));

    const openCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open");
    openCall?.[1]?.();

    expect(fakeFileStream.destroy).toHaveBeenCalled();
    expect(fakeFileStream.pipe).not.toHaveBeenCalled();
  });

  it("handles file stream error when headersSent is false by responding 500 or 404", async () => {
    await startHttp2Server();
    const fakeFileStream = {
      on: vi.fn().mockReturnThis(),
      pipe: vi.fn(),
      destroy: vi.fn(),
    };
    mockCreateReadStream.mockReturnValue(fakeFileStream);

    const handler = getStreamHandler()!;
    const stream = makeStream();
    (stream as any).headersSent = false;

    await handler(stream, makeHeaders("/style.css", "GET"));

    const errCall = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "error");
    const err = new Error("EACCES permission denied");
    (err as any).code = "EACCES";
    errCall?.[1]?.(err);

    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ":status": 500,
        "x-content-type-options": "nosniff",
      }),
    );
    expect(stream.end).toHaveBeenCalledWith("Internal Server Error");
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

describe("startHttp2Server – rate limiting details", () => {
  beforeEach(async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = true;
    await startHttp2Server();
  });

  afterEach(async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = false;
  });

  it("allows requests from different IPs independently", async () => {
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;

    // Exhaust quota for one IP
    for (let i = 0; i < 502; i++) {
      const s = { ...makeStream(), session: { socket: { remoteAddress: "1.2.3.4" } } };
      await handler(s, makeHeaders("/about", "GET"));
    }

    // A different IP should still be allowed
    const otherStream = { ...makeStream(), session: { socket: { remoteAddress: "9.9.9.9" } } };
    await handler(otherStream, makeHeaders("/about", "GET"));
    expect(otherStream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
  });

  it("handles empty/missing remoteIp safely in rate limiting without throwing", async () => {
    mockMem.getPage.mockReturnValue(makePage());
    const handler = getStreamHandler()!;

    // Stream with a null session socket/remoteAddress or throwing socket should resolve remoteIp as "unknown"
    const badStream1 = { ...makeStream(), session: { socket: null } };
    expect(() => handler(badStream1, makeHeaders("/about", "GET"))).not.toThrow();

    const badStream2 = {
      ...makeStream(),
      get session() {
        throw new Error("ERR_HTTP2_NO_SOCKET_MANIPULATION");
      },
    };
    expect(() => handler(badStream2, makeHeaders("/about", "GET"))).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Port auto-increment
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – port auto-increment", () => {
  afterEach(() => {
    // Restore default behavior so subsequent tests are unaffected.
    mockServer.listen.mockImplementation(
      (_port: number, _hostname: string, cb?: () => void) => { cb?.(); },
    );
  });

  it("retries the next port when the preferred port is in use", async () => {
    let callCount = 0;
    mockServer.listen.mockImplementation(
      (_port: number, _hostname: string, cb?: () => void) => {
        callCount++;
        if (callCount === 1) {
          // Fire the EADDRINUSE error through the once-registered handler.
          const [, errorHandler] = mockServer.once.mock.calls.at(-1) as [
            string,
            (err: NodeJS.ErrnoException) => void,
          ];
          const err = Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
          errorHandler(err);
        } else {
          cb?.();
        }
      },
    );

    await startHttp2Server();

    expect(mockServer.listen).toHaveBeenCalledTimes(2);
    expect(mockServer.listen).toHaveBeenNthCalledWith(1, 8443, "localhost", expect.any(Function));
    expect(mockServer.listen).toHaveBeenNthCalledWith(2, 8444, "localhost", expect.any(Function));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – graceful shutdown", () => {
  const registeredHandlers: Map<string, (() => void)[]> = new Map();

  beforeEach(() => {
    vi.spyOn(process, "once").mockImplementation((event: string | symbol, listener: (...args: any[]) => void) => {
      const key = String(event);
      if (!registeredHandlers.has(key)) registeredHandlers.set(key, []);
      registeredHandlers.get(key)!.push(listener as () => void);
      return process;
    });
  });

  afterEach(() => {
    registeredHandlers.clear();
    vi.restoreAllMocks();
  });

  it("registers SIGTERM and SIGINT handlers after the server starts", async () => {
    await startHttp2Server();
    const events = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("SIGTERM");
    expect(events).toContain("SIGINT");
  });

  it("calls server.close() and runShutdownHandlers on SIGTERM", async () => {
    await startHttp2Server();
    const [, sigTermHandler] = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c: any[]) => c[0] === "SIGTERM",
    ) as [string, () => void];

    const { runShutdownHandlers } = await import("./events.ts");
    const mockExit = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => undefined as never);
    sigTermHandler();
    expect(mockServer.close).toHaveBeenCalled();
    expect(runShutdownHandlers).toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("calls server.close() and runShutdownHandlers on SIGINT", async () => {
    await startHttp2Server();
    const [, sigIntHandler] = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c: any[]) => c[0] === "SIGINT",
    ) as [string, () => void];

    const { runShutdownHandlers } = await import("./events.ts");
    const mockExit = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => undefined as never);
    sigIntHandler();
    expect(mockServer.close).toHaveBeenCalled();
    expect(runShutdownHandlers).toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("ignores a second signal so shutdown runs only once", async () => {
    await startHttp2Server();
    const [, sigIntHandler] = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c: any[]) => c[0] === "SIGINT",
    ) as [string, () => void];
    const [, sigTermHandler] = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c: any[]) => c[0] === "SIGTERM",
    ) as [string, () => void];

    const mockExit = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => undefined as never);
    sigIntHandler();
    sigTermHandler(); // second signal during shutdown: must be a no-op
    expect(mockServer.close).toHaveBeenCalledTimes(1);
    mockExit.mockRestore();
  });

  it("destroys open sessions on SIGINT so long-lived SSE streams do not block shutdown", async () => {
    await startHttp2Server();

    const [, sessionHandler] = mockServer.on.mock.calls.find(
      (c: any[]) => c[0] === "session",
    ) as [string, (session: { destroy: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn> }) => void];

    const mockSession = { destroy: vi.fn(), once: vi.fn(), on: vi.fn() };
    sessionHandler(mockSession);

    const [, sigIntHandler] = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c: any[]) => c[0] === "SIGINT",
    ) as [string, () => void];

    const mockExit = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => undefined as never);
    sigIntHandler();
    expect(mockSession.destroy).toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("exits with code 0 on SIGINT", async () => {
    await startHttp2Server();
    const [, sigIntHandler] = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c: any[]) => c[0] === "SIGINT",
    ) as [string, () => void];

    const mockExit = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => undefined as never);
    sigIntHandler();
    expect(mockExit).toHaveBeenCalledWith(0);
    mockExit.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cert auto-generation
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – cert generation", () => {
  let mockAccess: ReturnType<typeof vi.fn>;
  let mockExecFile: ReturnType<typeof vi.fn>;

  // execFile is promisified; the callback is always the last argument.
  // mkcert gets an options object: execFile(cmd, args, opts, cb) → cb at index 3.
  // openssl has no options:        execFile(cmd, args, cb)       → cb at index 2.
  type ExecFileCb = (err: Error | null, stdout?: string, stderr?: string) => void;
  const lastArg = (args: unknown[]) => args[args.length - 1] as ExecFileCb;
  const succeed = (...args: unknown[]) => lastArg(args)(null, "", "");
  const fail = (msg: string) => (...args: unknown[]) => lastArg(args)(new Error(msg));

  beforeEach(async () => {
    const { access } = await import("node:fs/promises");
    const { execFile } = await import("node:child_process");
    mockAccess = access as ReturnType<typeof vi.fn>;
    mockExecFile = execFile as unknown as ReturnType<typeof vi.fn>;
    // Default for each cert test: certs already exist, execFile succeeds.
    mockAccess.mockResolvedValue(undefined);
    mockExecFile.mockImplementation(succeed);
  });

  it("skips cert generation when cert files already exist", async () => {
    await startHttp2Server();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("runs mkcert when cert files are missing", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));

    await startHttp2Server();

    expect(mockExecFile).toHaveBeenCalledWith(
      "mkcert",
      expect.arrayContaining(["-key-file", "-cert-file", "localhost"]),
      expect.objectContaining({ env: expect.any(Object) }),
      expect.any(Function),
    );
  });

  it("passes augmented PATH to mkcert so Homebrew bin dirs are included", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));

    await startHttp2Server();

    const [, , opts] = mockExecFile.mock.calls[0] as [string, string[], { env: { PATH: string } }, ExecFileCb];
    expect(opts.env.PATH).toContain("/opt/homebrew/bin");
    expect(opts.env.PATH).toContain("/usr/local/bin");
  });

  it("falls back to openssl when mkcert is not available", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockExecFile
      .mockImplementationOnce(fail("mkcert not found"))
      .mockImplementationOnce(succeed);

    await startHttp2Server();

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "openssl",
      expect.arrayContaining(["req", "-x509"]),
      expect.any(Function),
    );
  });

  it("logs a message when mkcert fails and openssl is used instead", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockExecFile
      .mockImplementationOnce(fail("spawn mkcert ENOENT"))
      .mockImplementationOnce(succeed);
    const consoleSpy = vi.spyOn(console, "log");

    await startHttp2Server();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("mkcert not found or failed"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE live-reload
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – SSE live-reload (/bascik-live-reload)", () => {
  const mockEventEmitter = eventEmitter as unknown as {
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await startHttp2Server();
  });

  /** Fires the registered "transpiled" event listener for /bascik-live-reload. */
  const fireTranspiled = (relativePagePath: string) => {
    const [, handler] = mockEventEmitter.on.mock.calls.find(
      (c: any[]) => c[0] === "transpiled",
    ) as [string, (arg: { relativePagePath: string }) => void];
    handler({ relativePagePath });
  };

  it("responds with content-type text/event-stream and sends a connected message", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ "content-type": "text/event-stream" }),
    );
    expect(stream.write).toHaveBeenCalledWith("data: connected\n\n");
  });

  it("sends reload when Referer header is absent (regression: was silently dropped)", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    // No referer header: simulates Safari, privacy extensions, or no-referrer policy.
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", undefined));
    fireTranspiled("pages/about.html");
    expect(stream.write).toHaveBeenCalledWith("data: reload\n\n");
  });

  it("sends reload when Referer matches the transpiled page", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/about"));
    fireTranspiled("pages/about.html");
    expect(stream.write).toHaveBeenCalledWith("data: reload\n\n");
  });

  it("sends reload when Referer lacks trailing slash but page path is an index route", async () => {
    // Browser Referer for /blog/index.html is typically `/blog` (no trailing slash),
    // but getHttpPath returns `/blog/`. The fix must normalize both before comparing.
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/blog"));
    fireTranspiled("pages/blog/index.html");
    expect(stream.write).toHaveBeenCalledWith("data: reload\n\n");
  });

  it("sends reload when Referer has trailing slash and page path is an index route", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/blog/"));
    fireTranspiled("pages/blog/index.html");
    expect(stream.write).toHaveBeenCalledWith("data: reload\n\n");
  });

  it("does not send reload when Referer is a different page than the one transpiled", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/getting-started"));
    fireTranspiled("pages/about.html");
    const reloadCalls = stream.write.mock.calls.filter((c: any[]) => c[0] === "data: reload\n\n");
    expect(reloadCalls).toHaveLength(0);
  });

  it("removes event listeners when the SSE stream closes", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    // Trigger the stream close callback registered by the handler.
    const closeCallback = stream.on.mock.calls.find((c: any[]) => c[0] === "close")?.[1] as () => void;
    closeCallback?.();
    expect(mockEventEmitter.removeListener).toHaveBeenCalledWith("transpiled", expect.any(Function));
    expect(mockEventEmitter.removeListener).toHaveBeenCalledWith("asset-changed", expect.any(Function));
  });

  it("calls mem.trackOpenPage with the referer pathname when a connection opens", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/faq"));
    expect(mockMem.trackOpenPage).toHaveBeenCalledWith("/faq");
  });

  it("calls mem.trackOpenPage with pathname stripped of query string and fragment when Referer has query parameters", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/faq?tab=settings&search=1#section"));
    expect(mockMem.trackOpenPage).toHaveBeenCalledWith("/faq");
  });

  it("sends reload when Referer header contains query string matching the transpiled page", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/about?ref=social"));
    fireTranspiled("pages/about.html");
    expect(stream.write).toHaveBeenCalledWith("data: reload\n\n");
  });

  it("calls mem.untrackOpenPage when the SSE stream closes", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/faq"));
    const closeCallback = stream.on.mock.calls.find((c: any[]) => c[0] === "close")?.[1] as () => void;
    closeCallback?.();
    expect(mockMem.untrackOpenPage).toHaveBeenCalledWith("/faq");
  });

  it("does not call mem.trackOpenPage when there is no Referer header", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", undefined));
    expect(mockMem.trackOpenPage).not.toHaveBeenCalled();
  });

  it("responds 404 in --server mode (SSE only runs in dev)", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = true;
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
    (BascikConfig as any).isProdServer = false;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onError helper – header/end error paths
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// fileStream error paths
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – fileStream error handling", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("does nothing when fileStream emits an error after the stream is destroyed", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    (stream as any).destroyed = true;

    await handler(stream, makeHeaders("/style.css", "GET"));
    const errorCb = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "error")?.[1] as (err: Error) => void;
    // Must not throw even if the stream is already destroyed
    expect(() => errorCb?.(new Error("read error"))).not.toThrow();
    // respond() must not be called on a destroyed stream
    expect(stream.respond).not.toHaveBeenCalled();
  });

  it("does nothing when stream is destroyed by the time the 'open' event fires", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn(), destroy: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();

    await handler(stream, makeHeaders("/style.css", "GET"));

    // Simulate client disconnect before the file descriptor opens
    (stream as any).destroyed = true;

    const openCb = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open")?.[1] as () => void;
    openCb?.();

    expect(stream.respond).not.toHaveBeenCalled();
    expect(fakeFileStream.pipe).not.toHaveBeenCalled();
    expect(fakeFileStream.destroy).toHaveBeenCalled();
  });

  it("closes stream via NGHTTP2_INTERNAL_ERROR when error occurs after headers sent", async () => {
    const mockClose = vi.fn();
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = { ...makeStream(), close: mockClose, destroyed: false };

    await handler(stream, makeHeaders("/style.css", "GET"));

    // Simulate the "open" event so headers are sent, then simulate an error.
    const openCb = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open")?.[1] as () => void;
    openCb?.(); // This calls stream.respond() → headers sent
    (stream as any).headersSent = true;

    const errorCb = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "error")?.[1] as (err: Error) => void;
    errorCb?.(new Error("pipe error"));
    expect(mockClose).toHaveBeenCalled();
  });

  it("responds 404 when ENOENT error occurs before headers are sent", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();

    await handler(stream, makeHeaders("/style.css", "GET"));
    const errorCb = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "error")?.[1] as (err: NodeJS.ErrnoException) => void;
    errorCb?.(Object.assign(new Error("not found"), { code: "ENOENT" }));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// logAccess – various skip conditions
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Query-string stripping and trailing-slash page lookup
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Static asset cache-control when cacheHttp is enabled
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – static asset cache-control (cacheHttp=true)", () => {
  beforeEach(async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.httpCache = true;
    await startHttp2Server();
  });

  afterEach(async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.httpCache = false;
  });

  it("adds cache-control public + etag for static assets when cacheHttp is true", async () => {
    const fakeFileStream = { on: vi.fn().mockReturnThis(), pipe: vi.fn() };
    mockCreateReadStream.mockReturnValue(fakeFileStream);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    const openCb = fakeFileStream.on.mock.calls.find((c: any[]) => c[0] === "open")?.[1] as () => void;
    openCb?.();
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        "cache-control": expect.stringContaining("public"),
        "etag": expect.any(String),
      }),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Port-in-use: non-EADDRINUSE error causes rejection
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// Server scripts: hasServerScripts=true path
// ─────────────────────────────────────────────────────────────────────────────

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
    const [, ctx] = mockExecute.mock.calls[0] as [string, { path: string; searchParams: Record<string, string>; headers: Record<string, string> }];
    expect(ctx.path).toBe("/greeting");
    expect(ctx.searchParams).toMatchObject({ color: "blue" });
    expect(ctx.headers).toMatchObject({ "x-test": "val" });
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

// ─────────────────────────────────────────────────────────────────────────────
// Custom cert configuration error
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – custom cert config error", () => {
  it("throws when custom cert files are configured but missing", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.tls = {
      certFile: "custom-cert.pem",
      keyFile: "custom-key.pem",
      enabled: true,
    };
    const { access } = await import("node:fs/promises");
    (access as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("ENOENT"));

    await expect(startHttp2Server()).rejects.toThrow("Custom TLS certificate files");
    (BascikConfig as any).http.tls = { enabled: true };
    (access as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Boot page (shown during initial dev-server startup)
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// SSE boot-done event
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – SSE boot-done event", () => {
  const mockEventEmitter = eventEmitter as unknown as {
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await startHttp2Server();
  });

  const fireBootDone = () => {
    const [, handler] = mockEventEmitter.on.mock.calls.find(
      (c: any[]) => c[0] === "boot-done",
    ) as [string, () => void];
    handler();
  };

  it("registers a boot-done listener on the SSE connection", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    const events = mockEventEmitter.on.mock.calls.map((c: any[]) => c[0]);
    expect(events).toContain("boot-done");
  });

  it("sends reload to the SSE client when boot-done fires", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload", "GET", "", "https://localhost:8443/about"));
    fireBootDone();
    expect(stream.write).toHaveBeenCalledWith("data: reload\n\n");
  });

  it("immediately reloads boot-page SSE clients when boot is already complete", async () => {
    mockMem.isBooting = false;
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload?boot=1"));
    expect(stream.write).toHaveBeenCalledWith("data: reload\n\n");
  });

  it("removes the boot-done listener when the SSE stream closes", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    const closeCallback = stream.on.mock.calls.find((c: any[]) => c[0] === "close")?.[1] as () => void;
    closeCallback?.();
    expect(mockEventEmitter.removeListener).toHaveBeenCalledWith("boot-done", expect.any(Function));
  });

  it("does not write to the SSE stream when it is destroyed (boot-done race)", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    (stream as any).destroyed = true;
    fireBootDone();
    // Only the initial "data: connected" write should be present, not a reload.
    expect(stream.write).not.toHaveBeenCalledWith("data: reload\n\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SSE destroyed-stream guards
// ─────────────────────────────────────────────────────────────────────────────

describe("startHttp2Server – SSE handlers do not write to a destroyed stream", () => {
  const mockEventEmitter = eventEmitter as unknown as {
    on: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    await startHttp2Server();
  });

  const fireEvent = (event: string, arg?: unknown) => {
    const [, cb] = mockEventEmitter.on.mock.calls.find(
      (c: any[]) => c[0] === event,
    ) as [string, (a?: unknown) => void];
    cb(arg);
  };

  it("does not write to the SSE stream when it is destroyed (transpiled race)", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    (stream as any).destroyed = true;
    fireEvent("transpiled", { relativePagePath: "pages/about.html" });
    expect(stream.write).not.toHaveBeenCalledWith("data: reload\n\n");
  });

  it("does not write to the SSE stream when it is destroyed (asset-changed race)", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    (stream as any).destroyed = true;
    fireEvent("asset-changed");
    expect(stream.write).not.toHaveBeenCalledWith("data: reload\n\n");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// onError – ERR_HTTP2_INVALID_STREAM suppression
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// startServerInstance – Signal Listener Cleanup
// ─────────────────────────────────────────────────────────────────────────────

describe("startServerInstance signal handler cleanup", () => {
  it("attaches process signal handlers on start and removes them when server closes", async () => {
    const processOnceSpy = vi.spyOn(process, "once");
    const processRemoveListenerSpy = vi.spyOn(process, "removeListener");

    let closeCb: (() => void) | undefined;
    const mockServer: any = {
      once: vi.fn((event: string, cb: any) => {
        if (event === "close") closeCb = cb;
        return mockServer;
      }),
      listen: vi.fn((_port: number, hostnameOrCb: any, cb?: () => void) => {
        const callback = typeof hostnameOrCb === "function" ? hostnameOrCb : cb;
        callback?.();
        return mockServer;
      }),
      on: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
    };

    await startServerInstance(mockServer, "http");

    expect(processOnceSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processOnceSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    expect(closeCb).toBeDefined();
    closeCb?.();

    expect(processRemoveListenerSpy).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(processRemoveListenerSpy).toHaveBeenCalledWith("SIGINT", expect.any(Function));

    processOnceSpy.mockRestore();
    processRemoveListenerSpy.mockRestore();
  });

  it("calls closeAllConnections on server when gracefulShutdown is triggered", async () => {
    let sigIntHandler: (() => void) | undefined;
    vi.spyOn(process, "once").mockImplementation((event: string | symbol, listener: (...args: any[]) => void) => {
      if (event === "SIGINT") sigIntHandler = listener as () => void;
      return process;
    });

    const mockExit = vi.spyOn(process, "exit").mockImplementation((() => { }) as any);
    const mockServerWithCloseAll: any = {
      once: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      listen: vi.fn((_port: number, hostnameOrCb: any, cb?: () => void) => {
        const callback = typeof hostnameOrCb === "function" ? hostnameOrCb : cb;
        callback?.();
        return mockServerWithCloseAll;
      }),
      close: vi.fn((cb?: (err?: Error) => void) => { cb?.(); }),
      closeAllConnections: vi.fn(),
      removeListener: vi.fn().mockReturnThis(),
    };

    await startServerInstance(mockServerWithCloseAll, "http");

    expect(sigIntHandler).toBeDefined();
    sigIntHandler!();

    expect(mockServerWithCloseAll.closeAllConnections).toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("rejects with RangeError if port search exceeds 65535", async () => {
    let portAttempt = 65535;
    const mockOverflowServer: any = {
      once: vi.fn((event: string, cb: any) => {
        if (event === "error") {
          cb({ code: "EADDRINUSE" });
        }
        return mockOverflowServer;
      }),
      listen: vi.fn((port: number, hostnameOrCb: any, cb?: () => void) => {
        portAttempt = port;
        return mockOverflowServer;
      }),
      on: vi.fn().mockReturnThis(),
      removeListener: vi.fn().mockReturnThis(),
    };

    await expect(startServerInstance(mockOverflowServer, "http")).rejects.toThrow(RangeError);
  });

  it("uses process.env.PORT when defined", async () => {
    const originalPort = process.env.PORT;
    process.env.PORT = "9992";

    try {
      const mockServer: any = {
        once: vi.fn().mockReturnThis(),
        listen: vi.fn((port: number, hostnameOrCb: any, cb?: () => void) => {
          const callback = typeof hostnameOrCb === "function" ? hostnameOrCb : cb;
          callback?.();
          return mockServer;
        }),
        on: vi.fn().mockReturnThis(),
        removeListener: vi.fn().mockReturnThis(),
      };

      const origin = await startServerInstance(mockServer, "http");
      expect(mockServer.listen).toHaveBeenCalledWith(9992, "localhost", expect.any(Function));
      expect(origin).toBe("http://localhost:9992");
    } finally {
      if (originalPort !== undefined) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
    }
  });

  it("prioritizes process.env.BASCIK_SERVER_PORT over process.env.PORT when defined", async () => {
    const originalServePort = process.env.BASCIK_SERVER_PORT;
    const originalPort = process.env.PORT;
    process.env.BASCIK_SERVER_PORT = "9443";
    process.env.PORT = "3000";

    try {
      const mockServer: any = {
        once: vi.fn().mockReturnThis(),
        listen: vi.fn((port: number, hostnameOrCb: any, cb?: () => void) => {
          const callback = typeof hostnameOrCb === "function" ? hostnameOrCb : cb;
          callback?.();
          return mockServer;
        }),
        on: vi.fn().mockReturnThis(),
        removeListener: vi.fn().mockReturnThis(),
      };

      const origin = await startServerInstance(mockServer, "http");
      expect(mockServer.listen).toHaveBeenCalledWith(9443, "localhost", expect.any(Function));
      expect(origin).toBe("http://localhost:9443");
    } finally {
      if (originalServePort !== undefined) {
        process.env.BASCIK_SERVER_PORT = originalServePort;
      } else {
        delete process.env.BASCIK_SERVER_PORT;
      }
      if (originalPort !== undefined) {
        process.env.PORT = originalPort;
      } else {
        delete process.env.PORT;
      }
    }
  });
});
