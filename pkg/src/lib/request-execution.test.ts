/**
 * Prompt 132: the host-neutral request execution core.
 *
 * Everything here runs with injected handlers and Web streams. No filesystem,
 * no ScriptRegistry, no Node response objects. The Node path (`server-scripts.ts`,
 * `api-runtime.ts`) is the behavior oracle: the same plans and semantics must
 * yield the same bytes, status, and headers here.
 */
import { describe, it, expect, vi } from "vitest";
import {
  composeBufferedResponse,
  streamComposedResponse,
  dispatchApiHandler,
  invokeWithDeadline,
  STREAM_LOOKAHEAD,
  type ExecutionPlan,
  type ExecutionSegment,
  type ScriptJobRunner,
  type StreamWriter,
} from "./request-execution.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const staticSeg = (text: string): ExecutionSegment => ({ kind: "static", bytes: enc.encode(text) });
const scriptSeg = (id: string, mode: "server" | "stream"): ExecutionSegment => ({ kind: "script", mode, id });
const plan = (...segments: ExecutionSegment[]): ExecutionPlan => ({
  segments,
  firstStreamIndex: segments.findIndex((s) => s.kind === "script" && s.mode === "stream"),
});

type Deferred = { promise: Promise<string>; resolve: (v: string) => void; reject: (e: Error) => void };
const deferred = (): Deferred => {
  let resolve!: (v: string) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

const runnerFrom = (table: Record<string, Deferred | (() => Promise<string>)>): ScriptJobRunner => {
  const runner: ScriptJobRunner = vi.fn(async (id: string) => {
    const target = table[id];
    if (!target) throw new Error(`unrouted job ${id}`);
    return typeof target === "function" ? target() : target.promise;
  });
  return runner;
};

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("composeBufferedResponse", () => {
  it("runs every job and joins outputs with static bytes in document order", async () => {
    const runner = runnerFrom({ a: () => Promise.resolve("<b>A</b>"), b: () => Promise.resolve("<i>B</i>") });
    const bytes = await composeBufferedResponse(
      plan(staticSeg("<p>x</p>"), scriptSeg("a", "server"), staticSeg("<p>y</p>"), scriptSeg("b", "stream"), staticSeg("<p>z</p>")),
      runner,
    );
    expect(dec.decode(bytes)).toBe("<p>x</p><b>A</b><p>y</p><i>B</i><p>z</p>");
  });

  it("propagates a job failure so the host can still send a 500 (nothing committed)", async () => {
    const runner = runnerFrom({ a: () => Promise.reject(new Error("boom")) });
    await expect(composeBufferedResponse(plan(scriptSeg("a", "server")), runner)).rejects.toThrow("boom");
  });

  it("round-trips multi-byte UTF-8 byte-exact", async () => {
    const runner = runnerFrom({ a: () => Promise.resolve("日本 🚀") });
    const bytes = await composeBufferedResponse(plan(staticSeg("héllo "), scriptSeg("a", "server"), staticSeg(" ünï")), runner);
    expect(dec.decode(bytes)).toBe("héllo 日本 🚀 ünï");
  });
});

describe("streamComposedResponse", () => {
  const collectingWriter = () => {
    const writes: string[] = [];
    let gate: (() => void) | undefined;
    const writer: StreamWriter = {
      write: vi.fn(async (chunk: Uint8Array) => {
        writes.push(dec.decode(chunk));
        if (gate) await new Promise<void>((r) => { gate = r; });
      }),
    };
    return { writes, writer, stall: () => { gate = () => {}; }, release: () => { const g = gate; gate = undefined; g?.(); } };
  };

  it("ready resolves only after every server job settles; commit gates writes; done finishes in order", async () => {
    const a = deferred();
    const s = deferred();
    const runner = runnerFrom({ a, s });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(staticSeg("1"), scriptSeg("a", "server"), staticSeg("2"), scriptSeg("s", "stream"), staticSeg("3")),
      runner,
      writer,
    );
    let ready = false;
    void streamer.ready.then(() => { ready = true; });
    await tick();
    expect(ready).toBe(false);
    a.resolve("A");
    await streamer.ready;
    expect(writes).toEqual([]);
    streamer.commit();
    await tick();
    // Static prefix and server output flow before the stream job resolves.
    expect(writes).toEqual(["1", "A", "2"]);
    s.resolve("S");
    await streamer.done;
    expect(writes).toEqual(["1", "A", "2", "S", "3"]);
  });

  it("a server job failure rejects ready and never writes; done settles quietly", async () => {
    const runner = runnerFrom({ a: () => Promise.reject(new Error("precommit")) });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(plan(staticSeg("1"), scriptSeg("a", "server")), runner, writer);
    await expect(streamer.ready).rejects.toThrow("precommit");
    await expect(streamer.done).resolves.toBeUndefined();
    expect(writes).toEqual([]);
  });

  it("a stream job failure after commit is reported through onStreamError and written as empty", async () => {
    const runner = runnerFrom({ s: () => Promise.reject(new Error("postcommit")) });
    const { writes, writer } = collectingWriter();
    const onStreamError = vi.fn();
    const streamer = streamComposedResponse(plan(staticSeg("1"), scriptSeg("s", "stream"), staticSeg("2")), runner, writer, { onStreamError });
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(writes).toEqual(["1", "2"]);
    expect(onStreamError).toHaveBeenCalledTimes(1);
    expect(onStreamError.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("bounded lookahead: at most STREAM_LOOKAHEAD + 1 stream jobs are in flight beyond the cursor", async () => {
    const jobs = ["s1", "s2", "s3", "s4"].map(() => deferred());
    const table = Object.fromEntries(jobs.map((d, i) => [`s${i + 1}`, d]));
    const runner = runnerFrom(table);
    const { writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(scriptSeg("s1", "stream"), scriptSeg("s2", "stream"), scriptSeg("s3", "stream"), scriptSeg("s4", "stream")),
      runner,
      writer,
    );
    await streamer.ready;
    streamer.commit();
    await tick();
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(STREAM_LOOKAHEAD + 1);
    jobs[0].resolve("1");
    await tick();
    expect((runner as ReturnType<typeof vi.fn>).mock.calls.length).toBe(STREAM_LOOKAHEAD + 2);
    jobs[1].resolve("2");
    jobs[2].resolve("3");
    jobs[3].resolve("4");
    await streamer.done;
  });

  it("abort before commit: nothing is written and done settles", async () => {
    const a = deferred();
    const runner = runnerFrom({ a });
    const { writes, writer } = collectingWriter();
    const abort = new AbortController();
    const streamer = streamComposedResponse(plan(staticSeg("1"), scriptSeg("a", "server")), runner, writer, { signal: abort.signal });
    abort.abort();
    a.resolve("A");
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(writes).toEqual([]);
  });

  it("abort while pulling: the walk stops and the writer is not called again", async () => {
    const s = deferred();
    const runner = runnerFrom({ s });
    const { writes, writer } = collectingWriter();
    const abort = new AbortController();
    const streamer = streamComposedResponse(plan(staticSeg("1"), scriptSeg("s", "stream"), staticSeg("2")), runner, writer, { signal: abort.signal });
    await streamer.ready;
    streamer.commit();
    await tick();
    expect(writes).toEqual(["1"]);
    abort.abort();
    s.resolve("S");
    await streamer.done;
    expect(writes).toEqual(["1"]);
  });

  it("toReadableStream returns a Response body without awaiting completion, and honors reader demand", async () => {
    const s = deferred();
    const runner = runnerFrom({ s });
    const streamer = streamComposedResponse(plan(staticSeg("head"), scriptSeg("s", "stream"), staticSeg("tail")), runner, undefined);
    await streamer.ready;
    const body = streamer.toReadableStream();
    // The body exists before the stream job has resolved: no full-body await.
    const reader = body.getReader();
    const first = await reader.read();
    expect(dec.decode(first.value)).toBe("head");
    s.resolve("S");
    const second = await reader.read();
    expect(dec.decode(second.value)).toBe("S");
    const third = await reader.read();
    expect(dec.decode(third.value)).toBe("tail");
    expect((await reader.read()).done).toBe(true);
  });

  it("toReadableStream: reader cancel aborts remaining jobs", async () => {
    const s1 = deferred();
    const s2 = deferred();
    const runner = runnerFrom({ s1, s2 });
    const streamer = streamComposedResponse(plan(staticSeg("a"), scriptSeg("s1", "stream"), scriptSeg("s2", "stream")), runner, undefined);
    await streamer.ready;
    const reader = streamer.toReadableStream().getReader();
    await reader.read();
    await reader.cancel();
    expect(streamer.signal.aborted).toBe(true);
    s1.resolve("x");
    await streamer.done;
  });
});

describe("invokeWithDeadline", () => {
  it("resolves the handler value and clears the timer", async () => {
    const clock = { setTimeout: vi.fn(() => 1 as unknown as ReturnType<typeof setTimeout>), clearTimeout: vi.fn() };
    const result = await invokeWithDeadline(async () => "ok", { timeoutMs: 100, clock });
    expect(result).toEqual({ ok: true, value: "ok", timedOut: false, aborted: false });
    expect(clock.clearTimeout).toHaveBeenCalled();
  });

  it("reports a deadline as timedOut and aborts the handler signal", async () => {
    let fire!: () => void;
    const clock = {
      setTimeout: vi.fn((cb: () => void) => { fire = cb; return 1 as unknown as ReturnType<typeof setTimeout>; }),
      clearTimeout: vi.fn(),
    };
    let seenSignal: AbortSignal | undefined;
    const pending = invokeWithDeadline(
      ({ signal }) => { seenSignal = signal; return new Promise<string>(() => {}); },
      { timeoutMs: 5, clock },
    );
    fire();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("a pre-aborted upstream signal settles as aborted without invoking the handler", async () => {
    const handler = vi.fn();
    const abort = new AbortController();
    abort.abort(new Error("gone"));
    const result = await invokeWithDeadline(handler, { signal: abort.signal });
    expect(handler).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it("observes a late rejection after settlement without an unhandled rejection", async () => {
    let fire!: () => void;
    const clock = {
      setTimeout: vi.fn((cb: () => void) => { fire = cb; return 1 as unknown as ReturnType<typeof setTimeout>; }),
      clearTimeout: vi.fn(),
    };
    let rejectLate!: (e: Error) => void;
    const pending = invokeWithDeadline(() => new Promise<string>((_, rej) => { rejectLate = rej; }), { timeoutMs: 5, clock });
    fire();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
    rejectLate(new Error("late"));
    await tick();
  });
});

describe("dispatchApiHandler", () => {
  const mod = {
    GET: vi.fn(async (req: Request, ctx: { params: Record<string, string> }) => Response.json({ id: ctx.params.id, u: req.url })),
    POST: vi.fn(async () => new Response("created", { status: 201, headers: [["set-cookie", "a=1"], ["set-cookie", "b=2"]] })),
  };
  const ctx = { params: { id: "7" }, remoteIp: "10.0.0.1" };

  it("returns 405 with a sorted Allow header for an unexported method", async () => {
    const res = await dispatchApiHandler(mod, new Request("http://x/api/u/7", { method: "DELETE" }), ctx);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
    expect(res.headers.has("connection")).toBe(false);
  });

  it("auto-OPTIONS is 204 with Allow and no CORS", async () => {
    const res = await dispatchApiHandler(mod, new Request("http://x/api/u/7", { method: "OPTIONS" }), ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS, POST");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("derived HEAD keeps status and headers and strips the body", async () => {
    const res = await dispatchApiHandler(mod, new Request("http://x/api/u/7", { method: "HEAD" }), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.body).toBeNull();
  });

  it("passes params and the request through and preserves multiple Set-Cookie", async () => {
    const res = await dispatchApiHandler(mod, new Request("http://x/api/u/7", { method: "GET" }), ctx);
    expect(await res.json()).toEqual({ id: "7", u: "http://x/api/u/7" });
    const post = await dispatchApiHandler(mod, new Request("http://x/api/u/7", { method: "POST" }), ctx);
    expect(post.status).toBe(201);
    expect(post.headers.getSetCookie()).toEqual(["a=1", "b=2"]);
  });

  it("a non-Response return is a generic 500 and the details go to the logger only", async () => {
    const onError = vi.fn();
    const res = await dispatchApiHandler({ GET: async () => "nope" }, new Request("http://x/api", { method: "GET" }), ctx, { onError });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("Internal Server Error");
    expect(onError).toHaveBeenCalled();
  });

  it("a thrown error is a generic 500; a timeout is 504; an upstream abort is 499", async () => {
    const thrown = await dispatchApiHandler({ GET: async () => { throw new Error("secret detail"); } }, new Request("http://x/api"), ctx, { onError: () => {} });
    expect(thrown.status).toBe(500);
    expect(await thrown.text()).not.toContain("secret detail");

    let fire!: () => void;
    const clock = {
      setTimeout: vi.fn((cb: () => void) => { fire = cb; return 1 as unknown as ReturnType<typeof setTimeout>; }),
      clearTimeout: vi.fn(),
    };
    const pending = dispatchApiHandler({ GET: () => new Promise<Response>(() => {}) }, new Request("http://x/api"), ctx, { timeoutMs: 5, clock, onError: () => {} });
    fire();
    expect((await pending).status).toBe(504);

    const abort = new AbortController();
    const aborted = dispatchApiHandler({ GET: () => new Promise<Response>(() => {}) }, new Request("http://x/api"), ctx, { signal: abort.signal });
    abort.abort();
    expect((await aborted).status).toBe(499);
  });

  it("the handler receives a cooperative signal and the platform context untouched", async () => {
    let seen: unknown;
    const platform = { name: "test", env: { KV: 1 } };
    await dispatchApiHandler(
      { GET: async (_r: Request, c: unknown, o: { signal: AbortSignal }) => { seen = { c, hasSignal: o.signal instanceof AbortSignal }; return new Response("ok"); } },
      new Request("http://x/api"),
      { ...ctx, platform },
    );
    expect(seen).toEqual({ c: { ...ctx, platform }, hasSignal: true });
  });
});
