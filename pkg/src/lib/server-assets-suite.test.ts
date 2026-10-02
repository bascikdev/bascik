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

  // Regression test for the cold-cache bug: the very first request to a
  // static asset in a fresh process (every server restart, every replica)
  // must already carry the content-hash ETag, not the mtime-based fallback
  // that used to be served synchronously while the real hash computed in
  // the background. This is the exact scenario prompt 39 claims to fix.
  it("serves a content-hash ETag on the FIRST request to a static asset, not an mtime fallback", async () => {
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
    const firstRequestCall = stream.respond.mock.calls[0][0] as Record<string, unknown>;
    const firstEtag = firstRequestCall["etag"] as string;
    // The mtime fallback looks like `"1705000000000-1024"`; a content hash is hex-only.
    expect(firstEtag).toMatch(/^"[0-9a-f]{32,64}"$/);
    (BascikConfig as any).http.httpCache = false;
    (BascikConfig as any).http.compression = true;
  });

  // Regression for prompt 107: a static asset response must NOT combine the
  // hash of one read with the bytes of a later, re-opened path. If the file is
  // atomically replaced (or written in place) between the hash-acquisition read
  // and the bytes-served read, the original code would serve NEW under OLD's
  // ETag. The selected representation must own its body and validator together.
  it("serves a static body whose bytes match its own advertised ETag, never a re-opened path", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).http.httpCache = true;
    (BascikConfig as any).http.compression = false;
    // The hash-acquisition read observes OLD bytes... (as the single ownership
    // read, these are the bytes whose hash is advertised AND delivered).
    const oldBytes = Buffer.from("OLD".repeat(300));
    mockReadFile.mockResolvedValueOnce(oldBytes);
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/style.css", "GET"));
    // The body delivered in the ownership model is the SAME buffer whose hash
    // the ETag advertises: handler hashes oldBytes and serves oldBytes.
    const expectedEtag = `"${createHash("sha256").update(oldBytes).digest("hex")}"`;
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ":status": 200,
        "content-length": oldBytes.byteLength,
        etag: expectedEtag,
      }),
    );
    expect(stream.end).toHaveBeenCalledWith(oldBytes);
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

    // Third GET with list containing matching ETag and other tags → 304
    const stream3 = makeStream();
    await handler(stream3, makeHeaders("/style.css", "GET", "", undefined, { "if-none-match": `"other-tag", ${etag}` }));
    expect(stream3.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 304 }),
    );

    // Fourth GET with weak representation of matching ETag → 304
    const stream4 = makeStream();
    const weakEtag = `W/${etag}`;
    await handler(stream4, makeHeaders("/style.css", "GET", "", undefined, { "if-none-match": weakEtag }));
    expect(stream4.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 304 }),
    );

    (BascikConfig as any).http.httpCache = false;
  });
});

describe("startHttp2Server – static representation failure paths", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("does not throw when the representation read fails on a destroyed response stream", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("read error"));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    (stream as any).destroyed = true;

    await expect(handler(stream, makeHeaders("/style.css", "GET"))).resolves.not.toThrow();
  });

  it("does not call respond() when the response stream is already destroyed", async () => {
    mockReadFile.mockRejectedValueOnce(new Error("read error"));
    const handler = getStreamHandler()!;
    const stream = makeStream();
    (stream as any).destroyed = true;

    await handler(stream, makeHeaders("/style.css", "GET"));
    expect(stream.respond).not.toHaveBeenCalled();
  });

  it("responds 404 when the representation owner finds no file (deletion after selection)", async () => {
    mockStat.mockResolvedValueOnce({ mtimeMs: 1_705_000_000_000, size: 1_024 });
    mockReadFile.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const handler = getStreamHandler()!;
    const stream = makeStream();

    await handler(stream, makeHeaders("/style.css", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
  });

  it("responds 404 when stat reports ENOENT", async () => {
    mockStat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const handler = getStreamHandler()!;
    const stream = makeStream();

    await handler(stream, makeHeaders("/style.css", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 404 }),
    );
  });
});

describe("startHttp2Server – streamed large-asset delivery (prompt 140)", () => {
  const LARGE = MAX_BUFFERED_ASSET_BYTES + 1;
  const handleStat = { size: LARGE, mtimeMs: 1_705_000_000_000, ino: 4242 };
  const expectedWeakEtag = `W/"${LARGE.toString(36)}-${(1_705_000_000_000).toString(36)}-${(4242).toString(36)}"`;

  /**
   * A response stand-in that is a REAL Writable (so `pipeline` can drive it)
   * with the HTTP/2 stream surface the adapter reads: respond/close/headersSent.
   */
  class FakeHttp2Stream extends Writable {
    chunks: Buffer[] = [];
    respond = vi.fn((_h: Record<string, unknown>) => { this.sent = true; });
    close = vi.fn((_code?: number) => { this.destroy(); });
    session = { socket: { remoteAddress: "127.0.0.1" } };
    private sent = false;
    get headersSent() { return this.sent; }
    _write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
      this.chunks.push(Buffer.from(chunk));
      cb();
    }
  }

  /**
   * A fake `fs.ReadStream`: `bytesRead` mirrors the real stream's counter so
   * the delivery's truncation check (`bytesRead !== size`) is exercised. A
   * real `Readable.from` has no `bytesRead`, and `undefined !== size` would
   * make every happy-path test look truncated.
   */
  const countingStream = (chunks: Buffer[]): Readable & { bytesRead: number } => {
    const stream = Readable.from(chunks) as Readable & { bytesRead: number };
    stream.bytesRead = chunks.reduce((n, c) => n + c.byteLength, 0);
    return stream;
  };

  const makeHandle = (body: Buffer | (() => Readable)) => {
    const close = vi.fn(async () => {});
    const createReadStream = vi.fn(() =>
      typeof body === "function" ? body() : countingStream([body]),
    );
    const handle = { stat: vi.fn(async () => handleStat), close, createReadStream };
    return { handle, close, createReadStream };
  };

  const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  let logSpy: ReturnType<typeof vi.fn>;

  /** The access-log line for `path`, or undefined when none was written. */
  const accessLineFor = (path: string): string | undefined =>
    logSpy.mock.calls.map((c: unknown[]) => String(c[0])).find((l: string) => l.startsWith("GET ") && l.includes(path));

  beforeEach(async () => {
    mockStat.mockResolvedValue({ mtimeMs: handleStat.mtimeMs, size: LARGE });
    errorSpy.mockClear();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {}) as unknown as ReturnType<typeof vi.fn>;
    (BascikConfig as any).logging = { level: "info", requests: true };
    await startHttp2Server();
  });

  afterEach(() => {
    mockStat.mockResolvedValue({ mtimeMs: 1_705_000_000_000, size: 1_024 });
    (logSpy as unknown as { mockRestore: () => void }).mockRestore();
  });

  it("streams the body from the opened handle with a weak ETag and content-length, then closes the handle", async () => {
    const body = Buffer.from("large-asset-bytes");
    const { handle, close, createReadStream } = makeHandle(body);
    mockOpen.mockResolvedValueOnce(handle);
    (BascikConfig as any).http.httpCache = true;

    const stream = new FakeHttp2Stream();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET", "br, gzip"));

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({
      ":status": 200,
      etag: expectedWeakEtag,
      "content-length": LARGE,
      "content-type": "image/png",
    }));
    // Never compressed on this tier.
    expect(stream.respond.mock.calls[0][0]).not.toHaveProperty("content-encoding");
    expect(Buffer.concat(stream.chunks).equals(body)).toBe(true);
    // The read range is clamped to the advertised content-length (finding #1):
    // a file that grows under the handle never leaks bytes past the framing.
    expect(createReadStream).toHaveBeenCalledWith({ start: 0, end: LARGE - 1, autoClose: false });
    expect(close).toHaveBeenCalledTimes(1);
    expect(getOpenStreamedAssetHandles()).toBe(0);
    (BascikConfig as any).http.httpCache = false;
  });

  it("answers HEAD from the handle's stat without creating a read stream and closes the handle", async () => {
    const { handle, close, createReadStream } = makeHandle(Buffer.from("x"));
    mockOpen.mockResolvedValueOnce(handle);

    const stream = new FakeHttp2Stream();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "HEAD"));

    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 200, "content-length": LARGE }));
    expect(createReadStream).not.toHaveBeenCalled();
    expect(stream.chunks).toEqual([]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns 304 on a weak If-None-Match match before opening a read stream", async () => {
    const { handle, close, createReadStream } = makeHandle(Buffer.from("x"));
    mockOpen.mockResolvedValueOnce(handle);
    (BascikConfig as any).http.httpCache = true;

    const stream = new FakeHttp2Stream();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET", "", undefined, { "if-none-match": expectedWeakEtag }));

    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 304, etag: expectedWeakEtag }));
    expect(createReadStream).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    (BascikConfig as any).http.httpCache = false;
  });

  it("destroys the transport (never a truncated 200) when the read fails after headers, and closes the handle", async () => {
    const failing = () => new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(Object.assign(new Error("EIO"), { code: "EIO" }));
      },
    });
    const { handle, close } = makeHandle(failing);
    mockOpen.mockResolvedValueOnce(handle);

    const stream = new FakeHttp2Stream();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET"));

    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 200 }));
    expect(stream.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("streamed asset read failed after headers"), expect.anything());
  });

  /**
   * Finding #6: a post-header failure is logged exactly once (by the delivery,
   * never again by the outer handler), the access log records a defined
   * status (500 for a server-side fault, 499 for a vanished peer), and the
   * HTTP/2 stream is closed with NGHTTP2_INTERNAL_ERROR so the peer sees a
   * server fault, not a cancel.
   */
  it("logs a post-header read failure once, closes HTTP/2 with NGHTTP2_INTERNAL_ERROR, and logs status 500", async () => {
    const failing = () => new Readable({
      read() {
        this.push(Buffer.from("partial"));
        this.destroy(Object.assign(new Error("EIO"), { code: "EIO" }));
      },
    });
    const { handle } = makeHandle(failing);
    mockOpen.mockResolvedValueOnce(handle);

    const stream = new FakeHttp2Stream();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET"));

    expect(stream.close).toHaveBeenCalledWith(2); // NGHTTP2_INTERNAL_ERROR (mocked constants)
    const streamedLogs = errorSpy.mock.calls.filter((c) => /streamed asset/.test(String(c[0])));
    expect(streamedLogs).toHaveLength(1);
    // Nothing propagated to the outer handler's error paths.
    expect(errorSpy.mock.calls.filter((c) => /Request\/Stream error|Unhandled error/.test(String(c[0])))).toHaveLength(0);
    expect(accessLineFor("/big.png")).toMatch(/^GET \/big\.png 500 /);
  });

  it("treats a short read (file shrank under the handle) as truncation: destroys the transport, logs once, status 500", async () => {
    // The stream ends cleanly but delivered fewer bytes than advertised.
    const short = () => countingStream([Buffer.from("only-some-bytes")]);
    const { handle, close } = makeHandle(short);
    mockOpen.mockResolvedValueOnce(handle);

    const stream = new FakeHttp2Stream();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET"));

    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 200, "content-length": LARGE }));
    expect(stream.close).toHaveBeenCalledWith(2);
    expect(stream.destroyed).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("streamed asset truncated after headers"));
    expect(accessLineFor("/big.png")).toMatch(/^GET \/big\.png 500 /);
  });

  it("logs status 499 (not 0, not 200) when the peer is already gone before headers", async () => {
    const { handle, close, createReadStream } = makeHandle(Buffer.from("x"));
    mockOpen.mockResolvedValueOnce(handle);

    const stream = new FakeHttp2Stream();
    stream.destroy();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET"));

    expect(createReadStream).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(accessLineFor("/big.png")).toMatch(/^GET \/big\.png 499 /);
  });

  it("logs status 499 when the peer aborts mid-body, without an error log", async () => {
    const { handle, close } = makeHandle(() => new Readable({
      read() {
        this.push(Buffer.from("first"));
        this.push(null);
      },
    }));
    mockOpen.mockResolvedValueOnce(handle);

    const stream = new FakeHttp2Stream();
    stream.respond.mockImplementationOnce(() => { (stream as any).sent = true; stream.destroy(); });
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET"));

    expect(close).toHaveBeenCalledTimes(1);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(accessLineFor("/big.png")).toMatch(/^GET \/big\.png 499 /);
  });

  it("responds 500 and closes the handle when the read stream cannot be created before headers", async () => {
    const { handle, close } = makeHandle(Buffer.from("x"));
    handle.createReadStream.mockImplementation(() => { throw new Error("EBADF"); });
    mockOpen.mockResolvedValueOnce(handle);

    const stream = new FakeHttp2Stream();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET"));

    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 500 }));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("closes the handle when the client aborts mid-stream (premature close is not a server fault)", async () => {
    const { handle, close } = makeHandle(() => new Readable({
      read() {
        // First chunk arrives, then the peer disappears before more is read.
        this.push(Buffer.from("first"));
        this.push(null);
      },
    }));
    mockOpen.mockResolvedValueOnce(handle);

    const stream = new FakeHttp2Stream();
    // Simulate the peer tearing down the transport as soon as headers commit.
    stream.respond.mockImplementationOnce(() => { (stream as any).sent = true; stream.destroy(); });
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET"));

    expect(close).toHaveBeenCalledTimes(1);
    expect(getOpenStreamedAssetHandles()).toBe(0);
    // No error is logged for a peer abort.
    expect(errorSpy).not.toHaveBeenCalledWith(expect.stringContaining("streamed asset read failed"), expect.anything());
  });

  it("responds 404 when a large file disappears between stat and open", async () => {
    mockOpen.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const stream = new FakeHttp2Stream();
    await getStreamHandler()!(stream, makeHeaders("/big.png", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(expect.objectContaining({ ":status": 404 }));
  });
});

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
