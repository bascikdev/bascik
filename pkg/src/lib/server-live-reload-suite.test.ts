import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";

// ─── Hoisted mock factories ───────────────────────────────────────────────────

const {
  mockServer,
  mockCreateSecureServer,
  registeredShutdownFns,
  mockExecuteServerScripts,
} = vi.hoisted(() => {
  const mockServer = {
    on: vi.fn().mockReturnThis(),
    once: vi.fn().mockReturnThis(),
    removeListener: vi.fn().mockReturnThis(),
    listen: vi
      .fn()
      .mockImplementation(
        (_port: number, hostnameOrCb: any, cb?: () => void) => {
          const callback =
            typeof hostnameOrCb === "function" ? hostnameOrCb : cb;
          callback?.();
        },
      ),
    close: vi.fn().mockImplementation((cb?: (err?: Error) => void) => {
      cb?.();
    }),
  };
  const mockCreateSecureServer = vi.fn(() => mockServer);
  const registeredShutdownFns: Array<() => void | Promise<void>> = [];
  const mockExecuteServerScripts = vi.fn(
    async (html: string, ..._rest: unknown[]) => html,
  );
  return {
    mockServer,
    mockCreateSecureServer,
    registeredShutdownFns,
    mockExecuteServerScripts,
  };
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
  mem: {
    getPage: vi.fn(),
    getPageExact: vi.fn(),
    trackOpenPage: vi.fn(),
    untrackOpenPage: vi.fn(),
    isBooting: false,
    setBootingDone: vi.fn(),
  },
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
    directory: {
      pages: "src/pages",
      components: ["src/components"],
      out: "dist",
    },
  },
}));

vi.mock("./events.js", () => ({
  eventEmitter: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  registerShutdownHandler: vi.fn((fn) => {
    registeredShutdownFns.push(fn);
  }),
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
      async (
        plan: any,
        request: unknown,
        context: unknown,
        timeout: number,
        filePath: string,
      ) =>
        Buffer.from(
          await mockExecuteServerScripts(
            plan.__html,
            request,
            context,
            timeout,
            filePath,
          ),
        ),
    ),
    streamServerScripts: vi.fn(),
    DEFAULT_SCRIPT_TIMEOUT_MS: 5000,
  };
});

vi.mock("./paths.js", () => ({
  // Faithful port of the real getHttpPath so is404Page logic is genuinely
  // exercised: pages/404.html → /404, pages/blog/index.html → /blog/.
  getHttpPath: vi.fn((p: string) =>
    p
      .replace(/^pages/, "")
      .replace(/\.html$/, "")
      .replace(/\/index$/, "/"),
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
import {
  getSseManager,
  resetActiveRateLimiter,
  resetSseManager,
  startServerInstance,
} from "./server.ts";
import { DEFAULT_MAX_SSE_CONNECTIONS } from "./sse.ts";
import { mem } from "./mem.ts";
import { getLiveReloadScript } from "./live-reload.ts";
import { BascikConfig } from "./config.ts";
import { createReadStream } from "node:fs";
import { stat, readFile, access, open } from "node:fs/promises";
import { Readable, Writable } from "node:stream";
import {
  MAX_BUFFERED_ASSET_BYTES,
  getOpenStreamedAssetHandles,
} from "./caching.ts";
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
const mockCreateReadStream = createReadStream as unknown as ReturnType<
  typeof vi.fn
>;
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
    const httpCall = mockServer.on.mock.calls.find(
      (c: any[]) => c[0] === "request",
    );
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
    ((stream: any, headers: any) => Promise<void>) | undefined;
};

/**
 * Returns a mock page suitable for most response tests. Pass
 * `hasServerScripts: true` to attach a stub `serverScriptPlan` built from the
 * page content (the executor mock forwards `__html` to the spy).
 */
const makePage = (overrides: Record<string, unknown> = {}) => {
  const { hasServerScripts, ...rest } = overrides as {
    hasServerScripts?: boolean;
  } & Record<string, unknown>;
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
    page.serverScriptPlan = {
      segments: [{ kind: "static", bytes: Buffer.from(html) }],
      firstStreamIndex: -1,
      __html: html,
    };
  }
  return page;
};

// ─────────────────────────────────────────────────────────────────────────────
// Server setup
// ─────────────────────────────────────────────────────────────────────────────

export {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  createHash,
  mockServer,
  mockCreateSecureServer,
  registeredShutdownFns,
  mockExecuteServerScripts,
  startHttp2Server,
  resetActiveRateLimiter,
  resetSseManager,
  startServerInstance,
  mem,
  BascikConfig,
  createReadStream,
  stat,
  readFile,
  access,
  open,
  Readable,
  Writable,
  MAX_BUFFERED_ASSET_BYTES,
  getOpenStreamedAssetHandles,
  exec,
  execFile,
  eventEmitter,
  mockMem,
  mockCreateReadStream,
  mockStat,
  mockOpen,
  mockReadFile,
  mockAccess,
  mockExec,
  mockExecFile,
  makeStream,
  makeHeaders,
  getStreamHandler,
  makePage,
};

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
    await handler(
      stream,
      makeHeaders("/bascik-live-reload", "GET", "", undefined),
    );
    fireTranspiled("pages/about.html");
    expect(stream.write).toHaveBeenCalledWith(
      expect.stringMatching(/^data: reload \d+\n\n$/),
    );
  });

  it("sends reload when Referer matches the transpiled page", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/about",
      ),
    );
    fireTranspiled("pages/about.html");
    expect(stream.write).toHaveBeenCalledWith(
      expect.stringMatching(/^data: reload \d+\n\n$/),
    );
  });

  it("sends reload when Referer lacks trailing slash but page path is an index route", async () => {
    // Browser Referer for /blog/index.html is typically `/blog` (no trailing slash),
    // but getHttpPath returns `/blog/`. The fix must normalize both before comparing.
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/blog",
      ),
    );
    fireTranspiled("pages/blog/index.html");
    expect(stream.write).toHaveBeenCalledWith(
      expect.stringMatching(/^data: reload \d+\n\n$/),
    );
  });

  it("sends reload when Referer has trailing slash and page path is an index route", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/blog/",
      ),
    );
    fireTranspiled("pages/blog/index.html");
    expect(stream.write).toHaveBeenCalledWith(
      expect.stringMatching(/^data: reload \d+\n\n$/),
    );
  });

  it("does not send reload when Referer is a different page than the one transpiled", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/getting-started",
      ),
    );
    fireTranspiled("pages/about.html");
    const reloadCalls = stream.write.mock.calls.filter(
      (c: any[]) => typeof c[0] === "string" && c[0].startsWith("data: reload"),
    );
    expect(reloadCalls).toHaveLength(0);
  });

  it("removes event listeners when the SSE stream closes", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    // Trigger the stream close callback registered by the handler.
    const closeCallback = stream.on.mock.calls.find(
      (c: any[]) => c[0] === "close",
    )?.[1] as () => void;
    closeCallback?.();
    expect(mockEventEmitter.removeListener).toHaveBeenCalledWith(
      "transpiled",
      expect.any(Function),
    );
    expect(mockEventEmitter.removeListener).toHaveBeenCalledWith(
      "asset-changed",
      expect.any(Function),
    );
  });

  // A page that loaded before its rebuild finished can miss the reload; the
  // connect message tells it which version is stored now.
  it("sends the stored version of the open page with the connected message", async () => {
    mockMem.getPageExact.mockImplementation((path: string) =>
      path === "/faq"
        ? makePage({
            content: Buffer.from(
              `<p>faq</p>${getLiveReloadScript("/bascik-live-reload", "41")}`,
            ),
          })
        : undefined,
    );
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/faq",
      ),
    );
    expect(stream.write).toHaveBeenCalledWith("data: connected 41\n\n");
  });

  it("calls mem.trackOpenPage with the referer pathname when a connection opens", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/faq",
      ),
    );
    expect(mockMem.trackOpenPage).toHaveBeenCalledWith("/faq");
  });

  it("calls mem.trackOpenPage with pathname stripped of query string and fragment when Referer has query parameters", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/faq?tab=settings&search=1#section",
      ),
    );
    expect(mockMem.trackOpenPage).toHaveBeenCalledWith("/faq");
  });

  it("sends reload when Referer header contains query string matching the transpiled page", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/about?ref=social",
      ),
    );
    fireTranspiled("pages/about.html");
    expect(stream.write).toHaveBeenCalledWith(
      expect.stringMatching(/^data: reload \d+\n\n$/),
    );
  });

  it("calls mem.untrackOpenPage when the SSE stream closes", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/faq",
      ),
    );
    const closeCallback = stream.on.mock.calls.find(
      (c: any[]) => c[0] === "close",
    )?.[1] as () => void;
    closeCallback?.();
    expect(mockMem.untrackOpenPage).toHaveBeenCalledWith("/faq");
  });

  it("does not call mem.trackOpenPage when there is no Referer header", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(
      stream,
      makeHeaders("/bascik-live-reload", "GET", "", undefined),
    );
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

describe("startHttp2Server – SSE connection cap", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  /** Fills the live-reload manager to its cap with idle stand-in clients. */
  const fillSseManager = () => {
    const manager = getSseManager();
    for (let i = 0; i < DEFAULT_MAX_SSE_CONNECTIONS; i++) {
      manager.addClient({
        headersSent: true,
        destroyed: false,
        write: vi.fn(() => true),
        end: vi.fn(),
        close: vi.fn(),
        on: vi.fn(),
        off: vi.fn(),
      } as any);
    }
    expect(manager.activeClientCount).toBe(DEFAULT_MAX_SSE_CONNECTIONS);
  };

  /**
   * A stream that behaves like Node's: a second `respond` after headers are
   * committed throws ERR_HTTP2_HEADERS_SENT.
   */
  const makeStrictStream = () => {
    const stream = makeStream();
    let headersSent = false;
    stream.respond = vi.fn(() => {
      if (headersSent) {
        const err = new Error("Response has already been initiated.");
        (err as NodeJS.ErrnoException).code = "ERR_HTTP2_HEADERS_SENT";
        throw err;
      }
      headersSent = true;
    });
    return stream;
  };

  it("answers 503 and ends the stream once the cap is reached, before committing a 200", async () => {
    fillSseManager();
    const handler = getStreamHandler()!;
    const stream = makeStrictStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "http://localhost:8443/about",
      ),
    );
    expect(stream.respond).toHaveBeenCalledTimes(1);
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 503 }),
    );
    expect(stream.respond).not.toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200 }),
    );
    expect(stream.end).toHaveBeenCalledWith("Too Many SSE Connections");
    expect(stream.write).not.toHaveBeenCalled();
    expect(getSseManager().activeClientCount).toBe(DEFAULT_MAX_SSE_CONNECTIONS);
  });

  it("does not leave the referring page tracked as open when the cap rejects the connection", async () => {
    fillSseManager();
    const handler = getStreamHandler()!;
    const stream = makeStrictStream();
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "http://localhost:8443/about",
      ),
    );
    // Either never tracked, or tracked and balanced: the open-page count for
    // /about must not stay raised by a connection that was refused.
    expect(mockMem.trackOpenPage.mock.calls.length).toBe(
      mockMem.untrackOpenPage.mock.calls.length,
    );
  });

  it("accepts a new connection again once a slot frees up", async () => {
    fillSseManager();
    const handler = getStreamHandler()!;
    const rejected = makeStrictStream();
    await handler(rejected, makeHeaders("/bascik-live-reload"));
    expect(rejected.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 503 }),
    );

    const manager = getSseManager();
    manager.removeClient(1);
    const accepted = makeStrictStream();
    await handler(accepted, makeHeaders("/bascik-live-reload"));
    expect(accepted.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        ":status": 200,
        "content-type": "text/event-stream",
      }),
    );
    expect(accepted.write).toHaveBeenCalledWith("data: connected\n\n");
  });
});

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
    await handler(
      stream,
      makeHeaders(
        "/bascik-live-reload",
        "GET",
        "",
        "https://localhost:8443/about",
      ),
    );
    fireBootDone();
    expect(stream.write).toHaveBeenCalledWith(
      expect.stringMatching(/^data: reload \d+\n\n$/),
    );
  });

  it("immediately reloads boot-page SSE clients when boot is already complete", async () => {
    mockMem.isBooting = false;
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload?boot=1"));
    expect(stream.write).toHaveBeenCalledWith(
      expect.stringMatching(/^data: reload \d+\n\n$/),
    );
  });

  it("removes the boot-done listener when the SSE stream closes", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/bascik-live-reload"));
    const closeCallback = stream.on.mock.calls.find(
      (c: any[]) => c[0] === "close",
    )?.[1] as () => void;
    closeCallback?.();
    expect(mockEventEmitter.removeListener).toHaveBeenCalledWith(
      "boot-done",
      expect.any(Function),
    );
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

  // During boot the `transpiled` event is buffered until the post phase ran,
  // so a boot page waits on the never-buffered `page-stored` event instead.
  describe("boot page reloads as soon as its own page is in memory", () => {
    const BOOT_PATH = "/bascik-live-reload?boot=1";
    const reloadWrites = (stream: ReturnType<typeof makeStream>) =>
      stream.write.mock.calls.filter((call: any[]) =>
        /^data: reload \d+\n\n$/.test(String(call[0])),
      );
    const firePageStored = (relativePagePath: string) => {
      const [, handler] = mockEventEmitter.on.mock.calls.find(
        (c: any[]) => c[0] === "page-stored",
      ) as [string, (arg: { relativePagePath: string }) => void];
      handler({ relativePagePath });
    };

    beforeEach(() => {
      mockMem.isBooting = true;
      mockMem.getPageExact.mockReturnValue(undefined);
    });

    afterEach(() => {
      mockMem.isBooting = false;
      mockMem.getPageExact.mockReset();
    });

    it("boot=1 client with Referer / reloads when / is stored before boot-done", async () => {
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(
        stream,
        makeHeaders(BOOT_PATH, "GET", "", "https://localhost:8443/"),
      );
      expect(reloadWrites(stream)).toHaveLength(0);

      // Another page landing in memory is not this tab's page.
      firePageStored("pages/about.html");
      expect(reloadWrites(stream)).toHaveLength(0);

      firePageStored("pages/index.html");
      expect(reloadWrites(stream)).toHaveLength(1);
      // The tab is leaving the boot page now, so every other reload listener
      // is retired: boot-done, a later page-stored match, and the buffered
      // `transpiled` event for this page that flushes at boot end.
      for (const event of [
        "boot-done",
        "page-stored",
        "transpiled",
        "asset-changed",
      ]) {
        expect(mockEventEmitter.removeListener).toHaveBeenCalledWith(
          event,
          expect.any(Function),
        );
      }
    });

    // The real page's own (non-boot) connection reloads once at boot end,
    // from the flushed `transpiled` event; boot-done would be a second reload
    // for the same tab milliseconds later.
    it("does not subscribe a non-boot client whose page is already in memory to boot-done", async () => {
      mockMem.getPageExact.mockReturnValue(makePage());
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(
        stream,
        makeHeaders(
          "/bascik-live-reload",
          "GET",
          "",
          "https://localhost:8443/",
        ),
      );
      expect(mockMem.getPageExact).toHaveBeenCalledWith("/");
      const events = mockEventEmitter.on.mock.calls.map((c: any[]) => c[0]);
      expect(events).not.toContain("boot-done");
      expect(events).toContain("transpiled");
      expect(reloadWrites(stream)).toHaveLength(0);
    });

    it("still subscribes a non-boot client to boot-done when its page is not in memory or it has no Referer", async () => {
      const handler = getStreamHandler()!;
      await handler(
        makeStream(),
        makeHeaders(
          "/bascik-live-reload",
          "GET",
          "",
          "https://localhost:8443/about",
        ),
      );
      await handler(makeStream(), makeHeaders("/bascik-live-reload"));
      const bootDoneSubscriptions = mockEventEmitter.on.mock.calls.filter(
        (c: any[]) => c[0] === "boot-done",
      );
      expect(bootDoneSubscriptions).toHaveLength(2);
    });

    it("matches an index route whose Referer omits the trailing slash", async () => {
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(
        stream,
        makeHeaders(BOOT_PATH, "GET", "", "https://localhost:8443/blog"),
      );
      firePageStored("pages/blog/index.html");
      expect(reloadWrites(stream)).toHaveLength(1);
    });

    it("reloads immediately on connect when its page is already in memory during boot", async () => {
      // The page landed between the boot page being served and the SSE
      // connection arriving, so no later page-stored event will announce it.
      mockMem.getPageExact.mockReturnValue(makePage());
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(
        stream,
        makeHeaders(BOOT_PATH, "GET", "", "https://localhost:8443/about"),
      );
      expect(mockMem.getPageExact).toHaveBeenCalledWith("/about");
      expect(reloadWrites(stream)).toHaveLength(1);
      expect(mockEventEmitter.removeListener).toHaveBeenCalledWith(
        "boot-done",
        expect.any(Function),
      );
    });

    it("keeps waiting on connect when its page is not in memory yet", async () => {
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(
        stream,
        makeHeaders(BOOT_PATH, "GET", "", "https://localhost:8443/about"),
      );
      expect(reloadWrites(stream)).toHaveLength(0);
      fireBootDone();
      expect(reloadWrites(stream)).toHaveLength(1);
    });

    it("does not subscribe a non-boot client, or a boot client without a Referer, to page-stored", async () => {
      const handler = getStreamHandler()!;
      await handler(
        makeStream(),
        makeHeaders(
          "/bascik-live-reload",
          "GET",
          "",
          "https://localhost:8443/",
        ),
      );
      await handler(makeStream(), makeHeaders(BOOT_PATH));
      const events = mockEventEmitter.on.mock.calls.map((c: any[]) => c[0]);
      expect(events).not.toContain("page-stored");
    });

    it("removes the page-stored listener when the SSE stream closes", async () => {
      const handler = getStreamHandler()!;
      const stream = makeStream();
      await handler(
        stream,
        makeHeaders(BOOT_PATH, "GET", "", "https://localhost:8443/"),
      );
      const closeCallback = stream.on.mock.calls.find(
        (c: any[]) => c[0] === "close",
      )?.[1] as () => void;
      closeCallback?.();
      expect(mockEventEmitter.removeListener).toHaveBeenCalledWith(
        "page-stored",
        expect.any(Function),
      );
    });
  });
});

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
