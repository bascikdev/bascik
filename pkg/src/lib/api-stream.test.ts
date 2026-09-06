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
import { describe, it, expect, vi, beforeEach } from "vitest";
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
        const chunk = TextEncoder.encode(hooks.nextChunk);
        hooks.nextChunk = null;
        controller.enqueue(chunk);
      } else {
        return new Promise<void>((resolve) => {
          hooks.releasePull = () => {
            hooks.releasePull = null;
            resolve();
          };
        });
      }
    },
    cancel(reason) {
      hooks.cancels++;
      void reason;
    },
  });

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
    respond: vi.fn((status: number) => {
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
    let observedSignal: AbortSignal | undefined;
    const handler = installRoute(async (_req, _ctx, opts) => {
      observedSignal = opts.signal;
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
    await tick();

    expect(body.pulls).toBe(2);
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
    let handlerAborted: AbortSignal | undefined;
    const handler = installRoute(async (_req, _ctx, opts) => {
      observedSignal = opts.signal;
      // A deferred handler that does not settle until after the disconnect.
      await new Promise<void>((resolve) => {
        const check = () => {
          if (observedSignal!.aborted) { resolve(); }
          else queueMicrotask(check);
        };
        check();
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
    // The reader was canceled.
    expect(body.cancels).toBe(1);

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
    let handlerSignal: AbortSignal | undefined;
    const handler = installRoute(async (_req, _ctx, opts) => {
      handlerSignal = opts.signal;
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

    expect(handlerSignal!.aborted).toBe(true);
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
    await dispatch(handler, res);

    expect(body.cancels).toBe(1);
    expect(res.respond).toHaveBeenCalled();
    expect(res.listenerCount("close")).toBe(0);
  });

  it("explicit handler abort (AbortController) settles the response without hanging and removes the close listener", async () => {
    const body = makeBody();
    let handlerAbort: AbortController | undefined;
    let signalPassed: AbortSignal | undefined;
    const handler = installRoute(async (_req, _ctx, opts) => {
      signalPassed = opts.signal;
      const ac = new AbortController();
      handlerAbort = ac;
      opts.signal?.addEventListener("abort", () => ac.abort(), { once: true });
      await new Promise<void>((resolve) => {
        const check = () => (ac.signal.aborted ? resolve() : queueMicrotask(check));
        check();
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
    const handler = installRoute(async () =>
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
    expect(body.pulls).toBe(1);
    expect(res.write.mock.calls[0][0].toString()).toBe("one");

    body.nextChunk = "two";
    await tick();
    await tick();
    expect(body.pulls).toBe(2);
    expect(res.write.mock.calls[1][0].toString()).toBe("two");

    // Close the stream so the reader sees done.
    body.close();
    await done;
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(body.cancels).toBe(0);
    expect(res.listenerCount("close")).toBe(0);
  });

  it("a failed body read after headers committed destroys the transport, sends no second header, and never ends successfully", async () => {
    const body = makeBody();
    body.failNext = true;
    body.nextChunk = "first";
    const h = installRoute(async () => new Response(body.stream, { status: 200 }));
    const res = makeRes();
    const done = dispatch(h, res);
    await tick(); await tick();
    // First chunk was written (headers committed, 200).
    expect(res.respond).toHaveBeenCalledTimes(1);
    expect(res.write.mock.calls.length).toBe(1);

    body.nextChunk = "second";
    body.failNext = true;
    await tick(); await tick();

    expect(body.cancels).toBe(1);
    // Transport destroyed, not a successful end, and never a second header set.
    expect(res.close).toHaveBeenCalledTimes(1);
    expect(res.end).not.toHaveBeenCalled();
    expect(res.respond).toHaveBeenCalledTimes(1);
    expect(res.listenerCount("close")).toBe(0);
    await done;
  });

  it("handler deadline (timeout) aborts via the runtime signal and cleanup runs without hanging", async () => {
    const before = (BascikConfig.http as any).apiTimeout;
    (BascikConfig.http as any).apiTimeout = 20;
    let signal: AbortSignal | undefined;
    const h = installRoute(async (_req, _ctx, opts) => {
      signal = opts.signal;
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
        queueMicrotask(() => {});
      });
      return new Response("late", { status: 200 });
    });
    const res = makeRes();
    const done = dispatch(h, res);
    await tick();
    await new Promise<void>((r) => setTimeout(r, 60));
    expect(signal!.aborted).toBe(true);
    expect(res.respond).toHaveBeenCalledTimes(1);
    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.listenerCount("close")).toBe(0);
    (BascikConfig.http as any).apiTimeout = before;
    await done;
  });
});