/**
 * A stream script that yields: the host-neutral core's part.
 *
 * A `data-bascik-stream` script may be an async generator (or return any
 * async iterable); each value it yields is written to the response as it is
 * produced. These tests cover the scheduler (`streamComposedResponse`,
 * `composeBufferedResponse`) and the deadline-bounded chunk source
 * (`invokeWithDeadline` with `chunks: true`) with injected runners, writers
 * and clocks. The Node host is covered in `server-scripts-chunks.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  collectScriptJobOutput,
  composeBufferedResponse,
  invokeWithDeadline,
  scriptChunkIterator,
  scriptChunkOutput,
  streamComposedResponse,
  STREAM_LOOKAHEAD,
  type ExecutionPlan,
  type ExecutionSegment,
  type ScriptJobOutput,
  type ScriptOutputRunner,
  type StreamWriter,
} from "./request-execution.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

const staticSeg = (text: string): ExecutionSegment => ({
  kind: "static",
  bytes: enc.encode(text),
});
const scriptSeg = (
  id: string,
  mode: "server" | "stream",
): ExecutionSegment => ({ kind: "script", mode, id });
const plan = (...segments: ExecutionSegment[]): ExecutionPlan => ({
  segments,
  firstStreamIndex: segments.findIndex(
    (s) => s.kind === "script" && s.mode === "stream",
  ),
});

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A gate a test opens by hand. */
const gate = () => {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
};

const runnerFrom = (
  table: Record<string, () => ScriptJobOutput | Promise<ScriptJobOutput>>,
): ScriptOutputRunner =>
  vi.fn(async (id: string) => {
    const target = table[id];
    if (!target) throw new Error(`unrouted job ${id}`);
    return target();
  });

const collectingWriter = () => {
  const writes: string[] = [];
  let stalled: (() => void) | undefined;
  let stalling = false;
  const writer: StreamWriter = {
    write: vi.fn(async (chunk: Uint8Array) => {
      writes.push(dec.decode(chunk));
      if (stalling)
        await new Promise<void>((r) => {
          stalled = r;
        });
    }),
  };
  return {
    writes,
    writer,
    stall: () => {
      stalling = true;
    },
    release: () => {
      stalling = false;
      const r = stalled;
      stalled = undefined;
      r?.();
    },
  };
};

describe("streamComposedResponse: a stream job that yields", () => {
  it("writes each yielded chunk as its own write, in order, between the static bytes", async () => {
    const runner = runnerFrom({
      s: async function* () {
        yield "<li>1</li>";
        yield "<li>2</li>";
        yield "<li>3</li>";
      },
    });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(staticSeg("<ul>"), scriptSeg("s", "stream"), staticSeg("</ul>")),
      runner,
      writer,
    );
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(writes).toEqual([
      "<ul>",
      "<li>1</li>",
      "<li>2</li>",
      "<li>3</li>",
      "</ul>",
    ]);
  });

  it("writes a chunk as soon as it is yielded, before the next one exists", async () => {
    const second = gate();
    const runner = runnerFrom({
      s: async function* () {
        yield "first";
        await second.opened;
        yield "second";
      },
    });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(staticSeg("["), scriptSeg("s", "stream"), staticSeg("]")),
      runner,
      writer,
    );
    await streamer.ready;
    streamer.commit();
    await tick();
    expect(writes).toEqual(["[", "first"]);
    second.open();
    await streamer.done;
    expect(writes).toEqual(["[", "first", "second", "]"]);
  });

  it("backpressure: the next chunk is not pulled until the write of the last one resolved", async () => {
    let produced = 0;
    const runner = runnerFrom({
      s: async function* () {
        for (let i = 1; i <= 3; i++) {
          produced = i;
          yield `c${i}`;
        }
      },
    });
    const { writes, writer, stall, release } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(scriptSeg("s", "stream")),
      runner,
      writer,
    );
    await streamer.ready;
    stall();
    streamer.commit();
    await tick();
    await tick();
    expect(writes).toEqual(["c1"]);
    expect(produced).toBe(1);
    release();
    await streamer.done;
    expect(writes).toEqual(["c1", "c2", "c3"]);
  });

  it("an empty chunk is not written", async () => {
    const runner = runnerFrom({
      s: async function* () {
        yield "";
        yield "a";
        yield "";
      },
    });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(scriptSeg("s", "stream")),
      runner,
      writer,
    );
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(writes).toEqual(["a"]);
  });

  it("a failure part-way keeps the chunks already sent, is reported once, and the rest of the page still goes out", async () => {
    const cleanedUp = vi.fn();
    const runner = runnerFrom({
      s: async function* () {
        try {
          yield "one";
          yield "two";
          throw new Error("row three failed");
        } finally {
          cleanedUp();
        }
      },
      t: () => "after",
    });
    const { writes, writer } = collectingWriter();
    const onStreamError = vi.fn();
    const streamer = streamComposedResponse(
      plan(
        staticSeg("<"),
        scriptSeg("s", "stream"),
        staticSeg("|"),
        scriptSeg("t", "stream"),
        staticSeg(">"),
      ),
      runner,
      writer,
      { onStreamError },
    );
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(writes).toEqual(["<", "one", "two", "|", "after", ">"]);
    expect(onStreamError).toHaveBeenCalledTimes(1);
    expect((onStreamError.mock.calls[0][0] as Error).message).toBe(
      "row three failed",
    );
    expect(onStreamError.mock.calls[0][1]).toBe("s");
    expect(cleanedUp).toHaveBeenCalledTimes(1);
  });

  it("an abort between chunks stops the walk, never writes again, and closes the generator so its finally runs", async () => {
    const cleanedUp = vi.fn();
    const more = gate();
    const runner = runnerFrom({
      s: async function* () {
        try {
          yield "one";
          await more.opened;
          yield "two";
          yield "three";
        } finally {
          cleanedUp();
        }
      },
    });
    const { writes, writer } = collectingWriter();
    const abort = new AbortController();
    const onStreamError = vi.fn();
    const streamer = streamComposedResponse(
      plan(staticSeg("["), scriptSeg("s", "stream"), staticSeg("]")),
      runner,
      writer,
      { signal: abort.signal, onStreamError },
    );
    await streamer.ready;
    streamer.commit();
    await tick();
    expect(writes).toEqual(["[", "one"]);
    abort.abort(new Error("client went away"));
    more.open();
    await streamer.done;
    await tick();
    expect(writes).toEqual(["[", "one"]);
    expect(cleanedUp).toHaveBeenCalledTimes(1);
    expect(onStreamError).not.toHaveBeenCalled();
  });

  it("a failure of the iterable after an abort is not reported", async () => {
    const more = gate();
    const runner = runnerFrom({
      s: async function* () {
        yield "one";
        await more.opened;
        throw new Error("aborted fetch");
      },
    });
    const { writer } = collectingWriter();
    const abort = new AbortController();
    const onStreamError = vi.fn();
    const streamer = streamComposedResponse(
      plan(scriptSeg("s", "stream")),
      runner,
      writer,
      { signal: abort.signal, onStreamError },
    );
    await streamer.ready;
    streamer.commit();
    await tick();
    abort.abort();
    more.open();
    await streamer.done;
    expect(onStreamError).not.toHaveBeenCalled();
  });

  it("lookahead: a yielding job ahead of the cursor has its first chunk pulled and no more", async () => {
    const firstDone = gate();
    let pulled = 0;
    const runner = runnerFrom({
      a: async () => {
        await firstDone.opened;
        return "A";
      },
      b: async function* () {
        for (let i = 1; i <= 3; i++) {
          pulled = i;
          yield `b${i}`;
        }
      },
    });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(scriptSeg("a", "stream"), scriptSeg("b", "stream")),
      runner,
      writer,
    );
    await streamer.ready;
    streamer.commit();
    await tick();
    await tick();
    expect(STREAM_LOOKAHEAD).toBeGreaterThanOrEqual(1);
    expect(writes).toEqual([]);
    // The body ran up to its first yield and is held there.
    expect(pulled).toBe(1);
    firstDone.open();
    await streamer.done;
    expect(writes).toEqual(["A", "b1", "b2", "b3"]);
  });

  it("a yielding job that was dispatched ahead but never reached is closed when the request aborts", async () => {
    const cleanedUp = vi.fn();
    const never = gate();
    const runner = runnerFrom({
      a: async () => {
        await never.opened;
        return "A";
      },
      b: async function* () {
        try {
          yield "b1";
          yield "b2";
        } finally {
          cleanedUp();
        }
      },
    });
    const { writes, writer } = collectingWriter();
    const abort = new AbortController();
    const streamer = streamComposedResponse(
      plan(scriptSeg("a", "stream"), scriptSeg("b", "stream")),
      runner,
      writer,
      { signal: abort.signal },
    );
    await streamer.ready;
    streamer.commit();
    await tick();
    abort.abort();
    never.open();
    await streamer.done;
    await tick();
    expect(writes).toEqual([]);
    expect(cleanedUp).toHaveBeenCalledTimes(1);
  });

  it("a failure of the first chunk of a job held ahead of the cursor is reported when its turn comes, not as an unhandled rejection", async () => {
    const firstDone = gate();
    const runner = runnerFrom({
      a: async () => {
        await firstDone.opened;
        return "A";
      },
      // eslint-disable-next-line require-yield
      b: async function* () {
        throw new Error("no rows");
      },
    });
    const { writes, writer } = collectingWriter();
    const onStreamError = vi.fn();
    const streamer = streamComposedResponse(
      plan(scriptSeg("a", "stream"), scriptSeg("b", "stream"), staticSeg("!")),
      runner,
      writer,
      { onStreamError },
    );
    await streamer.ready;
    streamer.commit();
    await tick();
    expect(onStreamError).not.toHaveBeenCalled();
    firstDone.open();
    await streamer.done;
    expect(writes).toEqual(["A", "!"]);
    expect(onStreamError).toHaveBeenCalledTimes(1);
  });

  it("a server job that yields is joined before ready resolves, so its failure can still be a 500", async () => {
    const more = gate();
    const runner = runnerFrom({
      a: async function* () {
        yield "x";
        await more.opened;
        yield "y";
      },
    });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(staticSeg("1"), scriptSeg("a", "server"), staticSeg("2")),
      runner,
      writer,
    );
    let ready = false;
    void streamer.ready.then(() => {
      ready = true;
    });
    await tick();
    expect(ready).toBe(false);
    more.open();
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(writes).toEqual(["1", "xy", "2"]);
  });

  it("a server job that fails while yielding rejects ready and nothing is written", async () => {
    const runner = runnerFrom({
      a: async function* () {
        yield "x";
        throw new Error("precommit");
      },
    });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(staticSeg("1"), scriptSeg("a", "server")),
      runner,
      writer,
    );
    await expect(streamer.ready).rejects.toThrow("precommit");
    await streamer.done;
    expect(writes).toEqual([]);
  });

  it("toReadableStream: each chunk is its own read, and a reader cancel closes the generator", async () => {
    const cleanedUp = vi.fn();
    const runner = runnerFrom({
      s: async function* () {
        try {
          yield "one";
          yield "two";
          yield "three";
        } finally {
          cleanedUp();
        }
      },
    });
    const streamer = streamComposedResponse(
      plan(staticSeg("head"), scriptSeg("s", "stream"), staticSeg("tail")),
      runner,
      undefined,
    );
    await streamer.ready;
    const reader = streamer.toReadableStream().getReader();
    expect(dec.decode((await reader.read()).value)).toBe("head");
    expect(dec.decode((await reader.read()).value)).toBe("one");
    expect(dec.decode((await reader.read()).value)).toBe("two");
    await reader.cancel();
    await streamer.done;
    await tick();
    expect(cleanedUp).toHaveBeenCalledTimes(1);
  });

  it("round-trips multi-byte chunks byte-exact", async () => {
    const runner = runnerFrom({
      s: async function* () {
        yield "日本";
        yield " 🚀";
      },
    });
    const { writes, writer } = collectingWriter();
    const streamer = streamComposedResponse(
      plan(scriptSeg("s", "stream")),
      runner,
      writer,
    );
    await streamer.ready;
    streamer.commit();
    await streamer.done;
    expect(writes.join("")).toBe("日本 🚀");
  });
});

describe("composeBufferedResponse: a job that yields", () => {
  it("joins the chunks with no separator, in document order", async () => {
    const runner = runnerFrom({
      a: async function* () {
        yield "<li>1</li>";
        yield "<li>2</li>";
      },
      b: () => "<p>b</p>",
    });
    const bytes = await composeBufferedResponse(
      plan(
        staticSeg("<ul>"),
        scriptSeg("a", "stream"),
        staticSeg("</ul>"),
        scriptSeg("b", "server"),
      ),
      runner,
    );
    expect(dec.decode(bytes)).toBe("<ul><li>1</li><li>2</li></ul><p>b</p>");
  });

  it("a failure while yielding rejects, so nothing is committed", async () => {
    const runner = runnerFrom({
      a: async function* () {
        yield "x";
        throw new Error("boom");
      },
    });
    await expect(
      composeBufferedResponse(plan(scriptSeg("a", "stream")), runner),
    ).rejects.toThrow("boom");
  });
});

describe("collectScriptJobOutput", () => {
  it("returns a string as it is and joins an iterable's chunks", async () => {
    expect(await collectScriptJobOutput("plain")).toBe("plain");
    expect(
      await collectScriptJobOutput(
        (async function* () {
          yield "a";
          yield "b";
        })(),
      ),
    ).toBe("ab");
  });
});

describe("scriptChunkIterator", () => {
  it("recognizes an async generator, any async iterable, and a sync generator", () => {
    expect(scriptChunkIterator((async function* () {})())).toBeDefined();
    expect(scriptChunkIterator((function* () {})())).toBeDefined();
    expect(
      scriptChunkIterator({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({ done: true, value: undefined }),
        }),
      }),
    ).toBeDefined();
  });

  it("misuse: a string, an array, a Promise, a Map, a plain object, null and a function are not chunk sources", () => {
    for (const value of [
      "text",
      ["a", "b"],
      Promise.resolve("x"),
      new Map(),
      new Set(["a"]),
      { next: () => ({ done: true }) },
      null,
      undefined,
      42,
      async function* () {},
    ])
      expect(scriptChunkIterator(value)).toBeUndefined();
  });

  it("misuse: an object whose Symbol.asyncIterator getter throws is not a chunk source", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("hostile");
        },
      },
    );
    expect(scriptChunkIterator(hostile)).toBeUndefined();
  });
});

/** A clock whose timers and time a test moves by hand. */
const manualClock = () => {
  let now = 0;
  let nextHandle = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    clock: {
      now: () => now,
      setTimeout: (cb: () => void, ms: number) => {
        const handle = nextHandle++;
        timers.set(handle, { at: now + ms, cb });
        return handle;
      },
      clearTimeout: (handle: unknown) => {
        timers.delete(handle as number);
      },
    },
    /** Move time forward, firing every timer that comes due. */
    advance: (ms: number) => {
      now += ms;
      for (const [handle, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(handle);
          timer.cb();
        }
      }
    },
    pending: () => timers.size,
  };
};

describe("invokeWithDeadline with chunks: a handler that returns a generator", () => {
  it("returns a source instead of a value; next() gives each yielded value, then done", async () => {
    const result = await invokeWithDeadline(
      async function* () {
        yield "a";
        yield "b";
      },
      { chunks: true },
    );
    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
    const source = result.source!;
    expect(await source.next()).toEqual({
      ok: true,
      value: { done: false, value: "a" },
      timedOut: false,
      aborted: false,
    });
    expect((await source.next()).value).toEqual({ done: false, value: "b" });
    expect((await source.next()).value).toEqual({
      done: true,
      value: undefined,
    });
    // Past the end it stays done.
    expect((await source.next()).value).toEqual({
      done: true,
      value: undefined,
    });
  });

  it("a sync generator is a source too", async () => {
    const result = await invokeWithDeadline(
      function* () {
        yield 1;
        yield 2;
      },
      { chunks: true },
    );
    const source = result.source!;
    expect((await source.next()).value).toEqual({ done: false, value: 1 });
    expect((await source.next()).value).toEqual({ done: false, value: 2 });
    expect((await source.next()).value?.done).toBe(true);
  });

  it("a generator the handler resolves to (an async function returning one) is a source", async () => {
    const result = await invokeWithDeadline(
      async () =>
        (async function* () {
          yield "late";
        })(),
      { chunks: true },
    );
    expect((await result.source!.next()).value).toEqual({
      done: false,
      value: "late",
    });
  });

  it("without chunks, a generator is an ordinary value and no source is made (API routes are unchanged)", async () => {
    const result = await invokeWithDeadline(async function* () {
      yield "a";
    });
    expect(result.ok).toBe(true);
    expect(result.source).toBeUndefined();
    expect(scriptChunkIterator(result.value)).toBeDefined();
  });

  it("with chunks, a value that is not a generator is returned as before, and the timer is cleared", async () => {
    const { clock, pending } = manualClock();
    const result = await invokeWithDeadline(async () => ["a", "b"], {
      chunks: true,
      timeoutMs: 100,
      clock,
    });
    expect(result).toEqual({
      ok: true,
      value: ["a", "b"],
      timedOut: false,
      aborted: false,
    });
    expect(pending()).toBe(0);
  });

  it("a throw inside the generator is that failure, not a timeout, and the source is finished", async () => {
    const result = await invokeWithDeadline(
      async function* () {
        yield "a";
        throw new Error("row failed");
      },
      { chunks: true, timeoutMs: 1000 },
    );
    const source = result.source!;
    await source.next();
    const failed = await source.next();
    expect(failed.ok).toBe(false);
    expect(failed.error?.message).toBe("row failed");
    expect(failed.timedOut).toBe(false);
    expect(failed.aborted).toBe(false);
    expect((await source.next()).value?.done).toBe(true);
  });

  it("the deadline counts the time the script takes to produce chunks, not the time between next() calls", async () => {
    const { clock, advance, pending } = manualClock();
    const gates = [gate(), gate()];
    const result = await invokeWithDeadline(
      async function* () {
        await gates[0].opened;
        yield "a";
        await gates[1].opened;
        yield "b";
      },
      { chunks: true, timeoutMs: 100, clock },
    );
    const source = result.source!;
    // Nothing is running, so no deadline is pending while the host is idle.
    expect(pending()).toBe(0);
    advance(10_000);

    const first = source.next();
    expect(pending()).toBe(1);
    advance(60);
    gates[0].open();
    expect((await first).value).toEqual({ done: false, value: "a" });
    expect(pending()).toBe(0);

    // A slow client: a long wait before the next pull costs the script nothing.
    advance(10_000);

    const second = source.next();
    advance(39);
    gates[1].open();
    expect((await second).value).toEqual({ done: false, value: "b" });
    expect((await source.next()).value?.done).toBe(true);
  });

  it("the deadline fires once the script's own time is spent: a timeout, the handler's signal aborts, and the generator is closed", async () => {
    const { clock, advance } = manualClock();
    const cleanedUp = vi.fn();
    let seen: AbortSignal | undefined;
    const first = gate();
    const result = await invokeWithDeadline(
      async function* ({ signal }) {
        seen = signal;
        try {
          await first.opened;
          yield "a";
          await new Promise(() => {});
          yield "never";
        } finally {
          cleanedUp();
        }
      },
      { chunks: true, timeoutMs: 100, clock },
    );
    const source = result.source!;
    const one = source.next();
    advance(60);
    first.open();
    await one;
    const two = source.next();
    advance(39);
    expect(seen?.aborted).toBe(false);
    advance(1);
    const timedOut = await two;
    expect(timedOut.ok).toBe(false);
    expect(timedOut.timedOut).toBe(true);
    expect(timedOut.aborted).toBe(false);
    expect(seen?.aborted).toBe(true);
    expect((await source.next()).value?.done).toBe(true);
  });

  it("an upstream abort between chunks reaches the handler's signal, and the next pull is an abort", async () => {
    const upstream = new AbortController();
    const cleanedUp = vi.fn();
    let seen: AbortSignal | undefined;
    const result = await invokeWithDeadline(
      async function* ({ signal }) {
        seen = signal;
        try {
          yield "a";
          yield "b";
        } finally {
          cleanedUp();
        }
      },
      { chunks: true, signal: upstream.signal, timeoutMs: 1000 },
    );
    const source = result.source!;
    await source.next();
    expect(seen?.aborted).toBe(false);
    upstream.abort(new Error("client went away"));
    expect(seen?.aborted).toBe(true);
    const aborted = await source.next();
    expect(aborted.ok).toBe(false);
    expect(aborted.aborted).toBe(true);
    expect(aborted.timedOut).toBe(false);
    await tick();
    expect(cleanedUp).toHaveBeenCalledTimes(1);
  });

  it("an upstream abort during a pull settles that pull as an abort even when the generator ignores the signal", async () => {
    const upstream = new AbortController();
    const result = await invokeWithDeadline(
      async function* () {
        await new Promise(() => {});
        yield "never";
      },
      { chunks: true, signal: upstream.signal },
    );
    const pull = result.source!.next();
    upstream.abort();
    const aborted = await pull;
    expect(aborted.ok).toBe(false);
    expect(aborted.aborted).toBe(true);
  });

  it("close() runs the generator's finally once, clears the deadline, and is safe to call again", async () => {
    const { clock, pending } = manualClock();
    const cleanedUp = vi.fn();
    const result = await invokeWithDeadline(
      async function* () {
        try {
          yield "a";
          yield "b";
        } finally {
          cleanedUp();
        }
      },
      { chunks: true, timeoutMs: 100, clock },
    );
    const source = result.source!;
    await source.next();
    source.close();
    source.close();
    await tick();
    expect(cleanedUp).toHaveBeenCalledTimes(1);
    expect(pending()).toBe(0);
    expect((await source.next()).value?.done).toBe(true);
  });

  it("misuse: a generator whose return() throws or rejects does not surface as an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      for (const fail of [
        () => {
          throw new Error("sync return");
        },
        () => Promise.reject(new Error("async return")),
      ]) {
        const result = await invokeWithDeadline(
          () => ({
            [Symbol.asyncIterator]() {
              return this;
            },
            next: async () => ({ done: false, value: "a" }),
            return: fail,
          }),
          { chunks: true },
        );
        await result.source!.next();
        expect(() => result.source!.close()).not.toThrow();
      }
      await tick();
      await tick();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("an abort before the handler runs never makes a source", async () => {
    const upstream = new AbortController();
    upstream.abort();
    const handler = vi.fn(async function* () {
      yield "a";
    });
    const result = await invokeWithDeadline(handler, {
      chunks: true,
      signal: upstream.signal,
    });
    expect(handler).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.source).toBeUndefined();
  });
});

describe("scriptChunkOutput", () => {
  const sourceOf = async (
    handler: Parameters<typeof invokeWithDeadline>[0],
    options: Parameters<typeof invokeWithDeadline>[1] = {},
  ) =>
    (await invokeWithDeadline(handler, { ...options, chunks: true })).source!;

  it("prints each value through the host's rule and skips what prints nothing", async () => {
    const source = await sourceOf(async function* () {
      yield 1;
      yield null;
      yield 2;
    });
    const chunks: string[] = [];
    for await (const chunk of scriptChunkOutput(
      source,
      (value) => (value === null ? "" : `<${String(value)}>`),
      () => "",
    ))
      chunks.push(chunk);
    expect(chunks).toEqual(["<1>", "<2>"]);
  });

  it("a failed pull goes to the host's failure rule: what it returns is the last chunk, what it throws ends the iteration", async () => {
    const failing = async function* () {
      yield "a";
      throw new Error("boom");
    };
    const quiet: string[] = [];
    for await (const chunk of scriptChunkOutput(
      await sourceOf(failing),
      String,
      () => "",
    ))
      quiet.push(chunk);
    expect(quiet).toEqual(["a"]);

    const loud = scriptChunkOutput(await sourceOf(failing), String, (r) => {
      throw new Error(`policy: ${r.error?.message}`);
    });
    const seen: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of loud) seen.push(chunk);
      })(),
    ).rejects.toThrow("policy: boom");
    expect(seen).toEqual(["a"]);
  });

  it("a print that throws ends the iteration and closes the generator", async () => {
    const cleanedUp = vi.fn();
    const source = await sourceOf(async function* () {
      try {
        yield "a";
        yield "b";
      } finally {
        cleanedUp();
      }
    });
    await expect(
      (async () => {
        for await (const _ of scriptChunkOutput(
          source,
          () => {
            throw new Error("refused");
          },
          () => "",
        )) {
          /* not reached */
        }
      })(),
    ).rejects.toThrow("refused");
    await tick();
    expect(cleanedUp).toHaveBeenCalledTimes(1);
  });

  it("stopping early (a consumer's break) closes the generator", async () => {
    const cleanedUp = vi.fn();
    const source = await sourceOf(async function* () {
      try {
        yield "a";
        yield "b";
      } finally {
        cleanedUp();
      }
    });
    for await (const chunk of scriptChunkOutput(source, String, () => "")) {
      expect(chunk).toBe("a");
      break;
    }
    await tick();
    expect(cleanedUp).toHaveBeenCalledTimes(1);
  });
});

describe("scriptChunkOutput: closing", () => {
  it("closes the source when the consumer returns before the first pull", async () => {
    const close = vi.fn();
    const output = scriptChunkOutput(
      { next: vi.fn(), close },
      String,
      () => "",
    );
    const iterator = output[Symbol.asyncIterator]();
    await iterator.return?.();
    expect(close).toHaveBeenCalledTimes(1);
    expect((await iterator.next()).done).toBe(true);
  });
});

describe("invokeWithDeadline with chunks: what the review found", () => {
  it("a value the generator returns is its last chunk, not dropped", async () => {
    const result = await invokeWithDeadline(
      async function* () {
        yield "a";
        return "last";
      },
      { chunks: true },
    );
    const source = result.source!;
    expect((await source.next()).value).toEqual({ done: false, value: "a" });
    expect((await source.next()).value).toEqual({
      done: false,
      value: "last",
    });
    expect((await source.next()).value?.done).toBe(true);
  });

  it("a generator that returns nothing adds no chunk", async () => {
    const result = await invokeWithDeadline(
      async function* () {
        yield "a";
        return;
      },
      { chunks: true },
    );
    await result.source!.next();
    expect((await result.source!.next()).value?.done).toBe(true);
  });

  it("close() while a pull is pending aborts the handler's signal, so the script can stop waiting and its finally runs", async () => {
    const cleanedUp = vi.fn();
    let seen: AbortSignal | undefined;
    const result = await invokeWithDeadline(
      async function* ({ signal }) {
        seen = signal;
        try {
          await new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          });
          yield "never";
        } finally {
          cleanedUp();
        }
      },
      { chunks: true, timeoutMs: 60_000 },
    );
    const source = result.source!;
    void source.next();
    await tick();
    expect(seen?.aborted).toBe(false);
    source.close();
    expect(seen?.aborted).toBe(true);
    await tick();
    expect(cleanedUp).toHaveBeenCalledTimes(1);
  });

  it("a source that finished by itself does not abort the handler's signal", async () => {
    let seen: AbortSignal | undefined;
    const result = await invokeWithDeadline(
      async function* ({ signal }) {
        seen = signal;
        yield "a";
      },
      { chunks: true },
    );
    await result.source!.next();
    await result.source!.next();
    result.source!.close();
    expect(seen?.aborted).toBe(false);
  });
});
