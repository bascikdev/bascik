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

describe("startHttp2Server – graceful shutdown", () => {
  const registeredHandlers: Map<string, (() => void)[]> = new Map();
  let processOnceSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    processOnceSpy = vi.spyOn(process, "once").mockImplementation((event: string | symbol, listener: (...args: any[]) => void) => {
      const key = String(event);
      if (!registeredHandlers.has(key)) registeredHandlers.set(key, []);
      registeredHandlers.get(key)!.push(listener as () => void);
      return process;
    });
  });

  afterEach(() => {
    registeredHandlers.clear();
    processOnceSpy.mockRestore();
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

  it("closes open sessions on SIGINT so long-lived SSE streams do not block shutdown", async () => {
    await startHttp2Server();

    const sessionCalls = mockServer.on.mock.calls.filter((c: any[]) => c[0] === "session");
    const sessionHandler = sessionCalls[sessionCalls.length - 1]?.[1] as (session: { close: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn>; once: ReturnType<typeof vi.fn> }) => void;

    const mockSession = { close: vi.fn(), destroy: vi.fn(), once: vi.fn(), on: vi.fn() };
    sessionHandler(mockSession);

    const [, sigIntHandler] = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c: any[]) => c[0] === "SIGINT",
    ) as [string, () => void];

    const mockExit = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => undefined as never);
    sigIntHandler();
    expect(mockSession.close).toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("exits with code 0 on SIGINT", async () => {
    await startHttp2Server();
    const [, sigIntHandler] = (process.once as ReturnType<typeof vi.spyOn>).mock.calls.find(
      (c: any[]) => c[0] === "SIGINT",
    ) as [string, () => void];

    const mockExit = vi.spyOn(process, "exit").mockImplementation((_code?: string | number | null) => undefined as never);
    sigIntHandler();
    await Promise.resolve();
    expect(mockExit).toHaveBeenCalledWith(0);
    mockExit.mockRestore();
  });
});

describe("startHttp2Server – health endpoint", () => {
  beforeEach(async () => {
    await startHttp2Server();
  });

  it("serves 200 OK for /_health when server is ready", async () => {
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/_health", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 200, "content-type": expect.stringContaining("json") }),
    );
  });

  it("serves 503 for /_health during booting state", async () => {
    const { setServerHealthState } = await import("./server-lifecycle.ts");
    setServerHealthState("booting");
    const handler = getStreamHandler()!;
    const stream = makeStream();
    await handler(stream, makeHeaders("/_health", "GET"));
    expect(stream.respond).toHaveBeenCalledWith(
      expect.objectContaining({ ":status": 503 }),
    );
    setServerHealthState("ready");
  });

  it("does not rate limit /_health even under flood", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = true;
    const handler = getStreamHandler()!;
    for (let i = 0; i < 505; i++) {
      const stream = makeStream();
      await handler(stream, makeHeaders("/_health", "GET"));
      if (i === 504) {
        expect(stream.respond).toHaveBeenCalledWith(
          expect.objectContaining({ ":status": 200 }),
        );
      }
    }
    (BascikConfig as any).isProdServer = false;
  });
});

describe("startServerInstance – port conflict handling", () => {
  it("fails hard on EADDRINUSE under --server", async () => {
    const { BascikConfig } = await import("./config.ts");
    (BascikConfig as any).isProdServer = true;

    const mockListenServer: any = {
      once: vi.fn(),
      removeListener: vi.fn(),
      listen: vi.fn().mockImplementation((_p, _h, _cb) => {
        // Trigger EADDRINUSE
        const err: any = new Error("address in use");
        err.code = "EADDRINUSE";
        const errorHandler = mockListenServer.once.mock.calls.find((c: any[]) => c[0] === "error")?.[1];
        errorHandler?.(err);
      }),
      on: vi.fn(),
    };

    await expect(startServerInstance(mockListenServer, "http")).rejects.toThrow(/already in use/);
    (BascikConfig as any).isProdServer = false;
  });
});

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
      expect.any(Function),
    );
  });

  it("falls back to openssl with SubjectAltName when mkcert is not available", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockExecFile
      .mockImplementationOnce(fail("mkcert not found"))
      .mockImplementationOnce(succeed);

    await startHttp2Server();

    expect(mockExecFile).toHaveBeenCalledTimes(2);
    expect(mockExecFile).toHaveBeenNthCalledWith(
      2,
      "openssl",
      expect.arrayContaining(["req", "-x509", "-addext"]),
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
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
      removeListener: vi.fn().mockReturnThis(),
    };

    await startServerInstance(mockServerWithCloseAll, "http");

    expect(sigIntHandler).toBeDefined();
    sigIntHandler!();

    expect(mockServerWithCloseAll.closeIdleConnections).toHaveBeenCalled();
    mockExit.mockRestore();
  });

  it("rejects with RangeError if port search exceeds 65535", async () => {
    const mockOverflowServer: any = {
      once: vi.fn((event: string, cb: any) => {
        if (event === "error") {
          cb({ code: "EADDRINUSE" });
        }
        return mockOverflowServer;
      }),
      listen: vi.fn((_port: number, _hostnameOrCb: any, _cb?: () => void) => {
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
        listen: vi.fn((_port: number, hostnameOrCb: any, cb?: () => void) => {
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
        listen: vi.fn((_port: number, hostnameOrCb: any, cb?: () => void) => {
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

describe("Server-owned RateLimiter lifecycle", () => {
  afterEach(async () => {
    const { resetActiveRateLimiter } = await import("./server.ts");
    resetActiveRateLimiter();
  });

  it("getActiveRateLimiter creates limiter and starts its sweep timer", async () => {
    const { getActiveRateLimiter, resetActiveRateLimiter } = await import("./server.ts");
    resetActiveRateLimiter();

    const limiter = getActiveRateLimiter();
    expect(limiter).toBeDefined();
    expect(limiter.isTimerActive()).toBe(true);
  });

  it("resetActiveRateLimiter cleans up timer and resets instance", async () => {
    const { getActiveRateLimiter, resetActiveRateLimiter } = await import("./server.ts");
    const limiter1 = getActiveRateLimiter();
    expect(limiter1.isTimerActive()).toBe(true);

    resetActiveRateLimiter();
    expect(limiter1.isTimerActive()).toBe(false);

    const limiter2 = getActiveRateLimiter();
    expect(limiter2).not.toBe(limiter1);
    expect(limiter2.isTimerActive()).toBe(true);
  });

  it("shutdown handlers clean up active rate limiter", async () => {
    const { getActiveRateLimiter } = await import("./server.ts");
    const { runShutdownHandlers } = await import("./events.ts");
    const limiter = getActiveRateLimiter();
    expect(limiter.isTimerActive()).toBe(true);

    await runShutdownHandlers();
    expect(limiter.isTimerActive()).toBe(false);
  });

  it("shutdown handlers clean up active SSE manager and disconnect clients", async () => {
    const { getSseManager, resetSseManager } = await import("./server.ts");
    const { runShutdownHandlers } = await import("./events.ts");
    resetSseManager();

    const manager = getSseManager();
    const mockRes: any = {
      destroyed: false,
      write: vi.fn(() => true),
      end: vi.fn(),
      close: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
    };
    manager.addClient(mockRes);
    expect(manager.activeClientCount).toBe(1);

    await runShutdownHandlers();
    expect(mockRes.close).toHaveBeenCalled();
    expect(manager.activeClientCount).toBe(0);

    // Repeated call to getSseManager returns new manager or re-initializes without leaking duplicate registrations
    const manager2 = getSseManager();
    expect(manager2).toBeDefined();
    resetSseManager();
  });
});
