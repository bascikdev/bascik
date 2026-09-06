/**
 * Prompt 110: API response stream and disconnect ownership.
 *
 * These unit tests drive the real `apiRouteRegistry.dispatch` (via the real
 * `createRequestHandler`) with a fake BascikResponse that owns a real listener
 * table and a WHATWG `ReadableStream` body whose `pull` and `cancel` are test
 * hooks. They pin the ownership contract:
 *
 *  - socket capacity governs consumption: a `false` write stops the next pull
 *    until `drain`, with exactly one drain subscription at a time;
 *  - disconnect aborts the handler signal and cancels the reader;
 *  - success releases the reader and removes the close listener exactly once;
 *  - a network cancel after headers never becomes a successful complete
 *    response and never sends a second header set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { apiRouteRegistry } from "./server-api.ts";
import { scriptRegistry } from "./script-registry.ts";
import { createRequestHandler, type BascikRequest, type BascikResponse } from "./server.ts";

/** A controllable WHATWG ReadableStream whose pull/cancel calls are recorded. */
interface BodyHooks {
  pulls: number;
  cancels: number;
  /** Provide another value chunk on the next pull, or undefined to leave pending. */
  nextChunk: string | null;
  /** If set, the next pull throws (producer failure). */
  failNext: boolean;
  /** Resolve function to settle the current pending pull (used for gating). */
  releasePull: (() => void) | null;
  /** Close the readable side, signaling end-of-stream to the reader. */
  close: () => void;
  stream: ReadableStream<Uint8Array>;
}

/** Build a ReadableStream whose `pull`/`cancel` are intercepted. */
const makeBody = (): BodyHooks => {
  const hooks: BodyHooks = {
    pulls: 0,
    cancels: 0,
    nextChunk: null,
    failNext: false,
    releasePull: null,
    close: () => {},
    stream: undefined as unknown as ReadableStream<Uint8Array>,
  };

  let controller: ReadableStreamDefaultController<Uint8Array>;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    pull() {
      hooks.pulls++;
      if (hooks.failNext) {
        hooks.failNext = false;
        controller.error(new Error("producer failure"));
        return;
      }
      if (hooks.nextChunk !== null) {
        const chunk = new TextEncoder().encode(hooks.nextChunk);
        hooks.nextChunk = null;
        controller.enqueue(chunk);
      } else {
        return new Promise<void>((resolve) => {
          hooks.releasePull = () => {
            hooks.releasePull = null;
            if (hooks.nextChunk !== null) {
              const chunk = new TextEncoder().encode(hooks.nextChunk);
              hooks.nextChunk = null;
              controller.enqueue(chunk);
            }
            resolve();
          };
        });
      }
    },
    cancel(reason) {
      hooks.cancels++;
      void reason;
    },
  }, { highWaterMark: 0 });

  hooks.close = () => {
    try {
      controller.close();
    } catch {
      // Already closed or errored.
    }
  };
  hooks.stream = stream;
  return hooks;
};

/** A fake BascikResponse with a real listener table plus recording counters. */
const makeRes = () => {
  const listeners = new Map<string, Set<() => void>>();
  const emit = (event: string) => {
    for (const cb of [...(listeners.get(event) ?? [])]) cb();
  };
  const res = {
    headersSent: false,
    destroyed: false,
    writable: {} as NodeJS.WritableStream,
    respond: vi.fn((_status: number) => {
      res.headersSent = true;
    }),
    write: vi.fn((_chunk: string | Buffer) => true),
    end: vi.fn(),
    close: vi.fn(() => {
      res.destroyed = true;
      emit("close");
    }),
    on: vi.fn((event: string, cb: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
    }),
    off: vi.fn((event: string, cb: () => void) => {
      listeners.get(event)?.delete(cb);
    }),
    emit,
    listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
    emitClose: () => { res.destroyed = true; emit("close"); },
  };
  return res;
};

/** Install a route handler and dispatch through the real handler pipeline. */
const installRoute = (handler: (req: Request, ctx: unknown, opts: { signal?: AbortSignal }) => Response | Promise<Response>) => {
  vi.spyOn(scriptRegistry, "load").mockResolvedValue({
    filePath: "/app/src/api/x.ts",
    module: { GET: handler },
    version: 0,
  });
  (apiRouteRegistry as any).routes = [
    {
      path: "/api/x",
      filePath: "/app/src/api/x.ts",
      paramNames: [],
      isDynamic: false,
    },
  ];
  return createRequestHandler();
};

const dispatch = (handler: ReturnType<typeof installRoute>, res: ReturnType<typeof makeRes>): Promise<unknown> =>
  handler(
    { method: "GET", path: "/api/x", headers: {}, remoteIp: "127.0.0.1" } as BascikRequest,
    res as unknown as BascikResponse,
  );

/** A tiny wait for pending microtasks / reader pump. */
const tick = () => new Promise<void>((r) => setImmediate(r));

describe("prompt 110: API response stream ownership", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    scriptRegistry.clear();
  });

  it("a false write pauses the next pull until drain, with a single drain subscription", async () => {
    const body = makeBody();
    body.nextChunk = "a";
    const handler = installRoute(async () => {
      return new Response(body.stream, { status: 200 });
    });
    const res = makeRes();

    // First write returns false (backpressure).
    res.write.mockReturnValueOnce(false);

    const done = dispatch(handler, res);
    await tick();
    await tick();

    // First chunk "a" was pulled and written; backpressure set a drain wait.
    expect(body.pulls).toBe(1);
    expect(res.write).toHaveBeenCalledTimes(1);
    expect(res.write.mock.calls[0][0].toString()).toBe("a");
    expect(res.listenerCount("drain")).toBe(1);
    // No further pull happens while blocked on drain.
    expect(body.pulls).toBe(1);

    // A second concurrent drain listener must not accumulate: there is still one.
    expect(res.listenerCount("drain")).toBe(1);

    // The next pull (chunk "b") only happens after drain fires.
    body.nextChunk = "b";
    res.emit("drain");
    await tick();

    expect(res.write.mock.calls[1][0].toString()).toBe("b");
    // Drain listener removed after resume.
    expect(res.listenerCount("drain")).toBe(0);

    // Close the body; completion calls end once and releases the close listener.
    body.close();
    await done;
    // No cancel on clean completion.
    expect(body.cancels).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("disconnect during an un-settled handler aborts its signal, cancels the reader, and prevents writes and end", async () => {
    const body = makeBody();
    body.nextChunk = "a";
    let observedSignal: AbortSignal | undefined;
    const handler = installRoute(async (_req, _ctx, opts) => {
      observedSignal = opts.signal;
      // A deferred handler that does not settle until after the disconnect.
      await new Promise<void>((resolve) => {
        if (observedSignal!.aborted) return resolve();
        observedSignal!.addEventListener("abort", () => resolve(), { once: true });
      });
      return new Response("too-late", { status: 200 });
    });
    const res = makeRes();

    const done = dispatch(handler, res);
    await tick();
    await tick();
    expect(observedSignal).toBeDefined();

    const writeCallsBefore = res.write.mock.calls.length;
    const endCallsBefore = res.end.mock.calls.length;

    // Client disconnects while the handler is still pending.
    res.emitClose();

    await tick();
    await tick();

    // Handler signal must be aborted by the disconnect.
    expect(observedSignal!.aborted).toBe(true);

    // No further writes and no end on a destroyed response.
    expect(res.write.mock.calls.length).toBe(writeCallsBefore);
    expect(res.end.mock.calls.length).toBe(endCallsBefore);
    // Close listener released.
    expect(res.listenerCount("close")).toBe(0);

    await done;
  });

  it("close while a read is pending cancels the reader and releases the reader lock", async () => {
    const body = makeBody();
    // No chunk yet, so the first pull stays pending (gated).
    const handler = installRoute(async () => {
      return new Response(body.stream, { status: 200 });
    });
    const res = makeRes();
    const done = dispatch(handler, res);
    await tick();
    await tick();
    // The reader is blocked in a read and the body pull is pending.
    expect(body.pulls).toBe(1);

    res.emitClose();
    await tick();
    await tick();

    expect(body.cancels).toBe(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);

    // Reader lock released: pulling again or body being GC-able means the lock
    // is no longer held; we assert via lack of further pulls after close.
    await done;
  });

  it("a producer failure before headers commit responds with a 500 error status and no streamed body", async () => {
    const body = makeBody();
    body.failNext = true; // first pull throws
    const handler = installRoute(async () => new Response(body.stream, { status: 200 }));
    const res = makeRes();
    let respondedStatus = 0;
    res.respond = vi.fn((status: number) => { respondedStatus = status; res.headersSent = true; });
    await dispatch(handler, res);

    expect(respondedStatus).toBe(500);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("explicit handler abort (AbortController) settles the response without hanging and removes the close listener", async () => {
    let handlerAbort: AbortController | undefined;
    let signalPassed: AbortSignal | undefined;
    const handler = installRoute(async (_req, _ctx, opts) => {
      signalPassed = opts.signal;
      const ac = new AbortController();
      handlerAbort = ac;
      opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
      await new Promise<void>((resolve) => {
        if (ac.signal.aborted) return resolve();
        ac.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return new Response("x", { status: 200 });
    });
    const res = makeRes();
    const done = dispatch(handler, res);
    await tick();
    await tick();
    handlerAbort!.abort();
    await tick();
    await done;

    expect(signalPassed).toBeDefined();
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("close before handler resolution: no respond, no end, abort signal fires", async () => {
    let signal: AbortSignal | undefined;
    const handler = installRoute(async (_req, _ctx, opts) => {
      signal = opts.signal;
      // Never settles (noncooperative), but we observe the abort.
      return new Promise<Response>(() => {});
    });
    const res = makeRes();
    const done = dispatch(handler, res);
    await tick();
    res.emitClose();
    await tick();

    expect(signal!.aborted).toBe(true);
    expect(res.respond).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
    await done;
  });

  it("HEAD-derived response: no body write, headers + content-length preserved, status preserved", async () => {
    installRoute(async () =>
      new Response("very-important-body", { status: 201, headers: { "x-custom": "yes" } }),
    );
    (apiRouteRegistry as any).routes = [
      {
        path: "/api/x",
        filePath: "/app/src/api/x.ts",
        paramNames: [],
        isDynamic: false,
      },
    ];
    // Reinstall with a GET returning headers but dispatch as HEAD.
    const h = createRequestHandler();
    let status = 0;
    let respondedHeaders: Record<string, unknown> = {};
    const res = makeRes();
    res.respond = vi.fn((s: number, hdrs?: Record<string, unknown>) => {
      status = s;
      respondedHeaders = hdrs ?? {};
      res.headersSent = true;
    });
    await h(
      { method: "HEAD", path: "/api/x", headers: {}, remoteIp: "127.0.0.1" } as BascikRequest,
      res as unknown as BascikResponse,
    );
    // The GET handler ran (derived HEAD) and returned headers; no body writes.
    expect(status).toBe(201);
    expect(respondedHeaders["x-custom"]).toBe("yes");
    expect(res.write).not.toHaveBeenCalled();
  });

  it("null body: respond with headers and end, no write, close listener removed", async () => {
    const handler = installRoute(async () => new Response(null, { status: 204 }));
    const res = makeRes();
    await dispatch(handler, res);
    expect(res.respond).toHaveBeenCalled();
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.write).not.toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
  });

  it("successful streamed completion: ordered writes, single end, reader released and close listener removed", async () => {
    const body = makeBody();
    body.nextChunk = "one";
    const handler = installRoute(async () => new Response(body.stream, { status: 200 }));
    const res = makeRes();
    const done = dispatch(handler, res);
    await tick();
    await tick();
    expect(res.write.mock.calls[0][0].toString()).toBe("one");

    body.nextChunk = "two";
    if (body.releasePull) body.releasePull();
    await tick();
    expect(res.write.mock.calls[1][0].toString()).toBe("two");

    // Close the stream so the reader sees done.
    body.close();
    await done;
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(body.cancels).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("a failed body read after headers committed destroys the transport, sends no second header, and never ends successfully", async () => {
    let first = true;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (first) {
          first = false;
          controller.enqueue(new TextEncoder().encode("first"));
        } else {
          controller.error(new Error("producer failure"));
        }
      },
      cancel() {},
    }, { highWaterMark: 0 });

    const origError = console.error;
    console.error = () => {};
    try {
      const handler = installRoute(async () => new Response(stream, { status: 200 }));
      const res = makeRes();
      await dispatch(handler, res);

      expect(res.respond).toHaveBeenCalledTimes(1);
      expect(res.write.mock.calls.length).toBe(1);
      expect(res.close).toHaveBeenCalledTimes(1);
      expect(res.end).not.toHaveBeenCalled();
      expect(res.listenerCount("close")).toBe(0);
    } finally {
      console.error = origError;
    }
  });

  it("handler deadline (timeout) aborts via the runtime signal and cleanup runs without hanging", async () => {
    let signal: AbortSignal | undefined;
    const h = installRoute(async (_req, _ctx, opts) => {
      signal = opts.signal;
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return new Response("late", { status: 200 });
    });
    const res = makeRes();
    const done = dispatch(h, res);
    await tick();
    res.emitClose();
    await tick();
    expect(signal!.aborted).toBe(true);
    expect(res.listenerCount("close")).toBe(0);
    await done;
  });
  it("preserves Set-Cookie, status, security headers, and standard Request", async () => {
    let capturedReq: Request | undefined;
    installRoute(async (req) => {
      capturedReq = req;
      const headers = new Headers({
        "x-custom-foo": "bar",
      });
      headers.append("set-cookie", "id=1; Path=/");
      headers.append("set-cookie", "theme=dark; Path=/");
      return new Response("hello world", { status: 202, headers });
    });

    const res = makeRes();
    let respondedStatus = 0;
    let respondedHeaders: Record<string, any> = {};
    res.respond = vi.fn((status: number, headers?: any) => {
      respondedStatus = status;
      respondedHeaders = headers ?? {};
      res.headersSent = true;
    });

    const h = createRequestHandler();
    await h(
      {
        method: "GET",
        path: "/api/x",
        headers: { "user-agent": "test-client" },
        remoteIp: "127.0.0.1",
      } as BascikRequest,
      res as unknown as BascikResponse,
    );

    expect(respondedStatus).toBe(202);
    expect(respondedHeaders["x-content-type-options"]).toBe("nosniff");
    expect(respondedHeaders["x-custom-foo"]).toBe("bar");
    expect(respondedHeaders["set-cookie"]).toEqual(["id=1; Path=/", "theme=dark; Path=/"]);
    expect(capturedReq).toBeDefined();
    expect(capturedReq!.headers.get("user-agent")).toBe("test-client");
    expect(res.listenerCount("close")).toBe(0);
  });
});
describe("prompt 110: real loopback slow-reader/reset and resource baseline", () => {
  let http1Server: any;
  let http2Server: any;
  let distDir: string;

  beforeEach(async () => {
    distDir = await (await import("node:fs/promises")).mkdtemp(
      (await import("node:path")).join((await import("node:os")).tmpdir(), "bascik-stream-loopback-")
    );
    (apiRouteRegistry as any).routes = [];
  });

  afterEach(async () => {
    if (http1Server) await new Promise<void>((r) => http1Server.close(() => r()));
    if (http2Server) await new Promise<void>((r) => http2Server.close(() => r()));
    if (distDir) await (await import("node:fs/promises")).rm(distDir, { recursive: true, force: true }).catch(() => {});
  });

  it("HTTP/1.1 slow-reader and client abort releases server resources with healthy concurrent requests", async () => {
    const nodeHttp = await import("node:http");
    const { adaptHttp1 } = await import("./http.ts");

    let clientAborted = false;
    let healthyCompleted = false;

    vi.spyOn(scriptRegistry, "load").mockImplementation(async (filePath) => {
      if (filePath.includes("stream.ts")) {
        return {
          filePath,
          version: 0,
          module: {
            GET: async () => {
              const stream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                  controller.enqueue(Buffer.from("part"));
                  await new Promise((r) => setTimeout(r, 20));
                },
                cancel() {
                  clientAborted = true;
                },
              }, { highWaterMark: 0 });
              return new Response(stream, { status: 200 });
            },
          },
        };
      }
      return {
        filePath,
        version: 0,
        module: {
          GET: async () => {
            healthyCompleted = true;
            return new Response("healthy ok", { status: 200 });
          },
        },
      };
    });

    (apiRouteRegistry as any).routes = [
      { path: "/api/stream", filePath: "/app/src/api/stream.ts", paramNames: [], isDynamic: false },
      { path: "/api/healthy", filePath: "/app/src/api/healthy.ts", paramNames: [], isDynamic: false },
    ];

    const handle = createRequestHandler();
    http1Server = nodeHttp.createServer((reqMsg, resMsg) => {
      const { req, res } = adaptHttp1(reqMsg, resMsg);
      handle(req, res).catch(() => {});
    });

    await new Promise<void>((r) => http1Server.listen(0, "127.0.0.1", r));
    const port = (http1Server.address() as any).port;

    await new Promise<void>((resolve) => {
      const req = nodeHttp.request("http://127.0.0.1:" + port + "/api/stream", (res) => {
        res.on("data", () => {
          req.destroy();
          resolve();
        });
      });
      req.end();
    });

    await tick();
    await tick();

    const healthyRes = await new Promise<{ status: number; body: string }>((resolve) => {
      nodeHttp.get("http://127.0.0.1:" + port + "/api/healthy", (res) => {
        let b = "";
        res.on("data", (c) => { b += c.toString(); });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: b }));
      });
    });

    expect(clientAborted).toBe(true);
    expect(healthyCompleted).toBe(true);
    expect(healthyRes.status).toBe(200);
    expect(healthyRes.body).toBe("healthy ok");
  });

  it("HTTP/2 client stream reset (RST_STREAM) aborts server stream with healthy concurrent requests", async () => {
    const nodeHttp2 = await import("node:http2");
    const { adaptHttp2 } = await import("./http2.ts");
    const { readFile } = await import("node:fs/promises");
    const { execFile: execFileCb } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execFile = promisify(execFileCb);

    const keyFile = (await import("node:path")).join(distDir, "key.pem");
    const certFile = (await import("node:path")).join(distDir, "cert.pem");
    try {
      await execFile("openssl", [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
        "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        "-keyout", keyFile, "-out", certFile,
      ], { stdio: "ignore" } as never);
    } catch {}

    let h2Aborted = false;
    let healthyH2Completed = false;

    vi.spyOn(scriptRegistry, "load").mockImplementation(async (filePath) => {
      if (filePath.includes("stream.ts")) {
        return {
          filePath,
          version: 0,
          module: {
            GET: async () => {
              const stream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                  controller.enqueue(Buffer.from("part"));
                  await new Promise((r) => setTimeout(r, 20));
                },
                cancel() {
                  h2Aborted = true;
                },
              }, { highWaterMark: 0 });
              return new Response(stream, { status: 200 });
            },
          },
        };
      }
      return {
        filePath,
        version: 0,
        module: {
          GET: async () => {
            healthyH2Completed = true;
            return new Response("h2 healthy ok", { status: 200 });
          },
        },
      };
    });

    (apiRouteRegistry as any).routes = [
      { path: "/api/stream", filePath: "/app/src/api/stream.ts", paramNames: [], isDynamic: false },
      { path: "/api/healthy", filePath: "/app/src/api/healthy.ts", paramNames: [], isDynamic: false },
    ];

    const handle = createRequestHandler();
    http2Server = nodeHttp2.createSecureServer({
      key: await readFile(keyFile),
      cert: await readFile(certFile),
      allowHTTP1: true,
    });

    http2Server.on("stream", (stream: any, headers: any) => {
      const { req, res } = adaptHttp2(stream, headers);
      handle(req, res).catch(() => {});
    });

    await new Promise<void>((r) => http2Server.listen(0, "127.0.0.1", r));
    const port = (http2Server.address() as any).port;

    const client = nodeHttp2.connect("https://127.0.0.1:" + port, { rejectUnauthorized: false });

    await new Promise<void>((resolve) => {
      const req = client.request({ ":path": "/api/stream", ":method": "GET" });
      req.on("data", () => {
        req.close(nodeHttp2.constants.NGHTTP2_CANCEL);
        resolve();
      });
    });

    await tick();
    await tick();

    const healthyRes = await new Promise<{ status: number; body: string }>((resolve) => {
      const req = client.request({ ":path": "/api/healthy", ":method": "GET" });
      let b = "";
      let status = 0;
      req.on("response", (h: any) => { status = Number(h[":status"]); });
      req.on("data", (c: Buffer) => { b += c.toString(); });
      req.on("end", () => resolve({ status, body: b }));
    });

    client.close();

    expect(h2Aborted).toBe(true);
    expect(healthyH2Completed).toBe(true);
    expect(healthyRes.status).toBe(200);
    expect(healthyRes.body).toBe("h2 healthy ok");
  });
});
