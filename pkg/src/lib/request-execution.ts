/**
 * @module request-execution
 *
 * Host-neutral request execution core (prompt 132).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The one scheduler behind `data-bascik-server` / `data-bascik-stream` pages
 * and API route dispatch, written against Web platform primitives only:
 * `Uint8Array`, `TextEncoder`, `ReadableStream`, `AbortController`,
 * `Request`/`Response`. It has no knowledge of the filesystem, module
 * loading, sockets, or Node response objects. Hosts supply:
 *
 * - an `ExecutionPlan` (immutable segments in document order),
 * - a `ScriptJobRunner` that turns a job id into its output string,
 * - a `StreamWriter` (or use `toReadableStream()` for a Web `Response` body),
 * - an optional `AbortSignal`, deadline clock, and error reporter.
 *
 * Semantics preserved from the Node implementation, byte for byte:
 * - every `server` job settles before `ready` resolves; a failure rejects
 *   `ready` so the host can still answer 500 (nothing committed);
 * - after `commit()`, static bytes and outputs are written in document order;
 * - `stream` jobs dispatch through a bounded lookahead window that advances
 *   with the write cursor, so a slow consumer also slows dispatch;
 * - a `stream` failure after commit is reported and written as empty;
 * - an abort stops the walk and the writer is never called again.
 *
 * This module MUST stay free of `node:*` imports and of any module that
 * touches config, the filesystem, or process state.
 * `serverless-contract.test.ts` bundles it for `platform: "browser"`.
 */

export type ScriptMode = "server" | "stream";

export interface StaticExecutionSegment {
  kind: "static";
  bytes: Uint8Array;
}

export interface ScriptExecutionSegment {
  kind: "script";
  mode: ScriptMode;
  /** Opaque job identity the host's runner understands. */
  id: string;
}

export type ExecutionSegment = StaticExecutionSegment | ScriptExecutionSegment;

export interface ExecutionPlan {
  segments: readonly ExecutionSegment[];
  /** Index into `segments` of the first `stream` script, or -1 when none. */
  firstStreamIndex: number;
}

/**
 * Resolve one script job to its output. Throwing is how a host signals a
 * failure the scheduler should treat as precommit (server) or postcommit
 * (stream). The runner receives the request signal so it can cancel work.
 */
export type ScriptJobRunner = (
  id: string,
  signal: AbortSignal,
) => Promise<string>;

/** Where streamed bytes go. Resolving the promise is the demand signal. */
export interface StreamWriter {
  write(chunk: Uint8Array): Promise<void>;
}

/**
 * How many `stream` jobs beyond the one the write cursor is waiting on may
 * be in flight at once. One keeps a fast consumer overlapping adjacent jobs
 * while a stalled consumer caps unwritten output held in memory.
 */
export const STREAM_LOOKAHEAD = 1;

const encoder = new TextEncoder();

const concat = (parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const part of parts) total += part.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
};

/**
 * Buffered composition: every job runs concurrently, then outputs are joined
 * with the static segments into one byte array. A job failure rejects, and
 * nothing has been committed.
 */
export const composeBufferedResponse = async (
  plan: ExecutionPlan,
  run: ScriptJobRunner,
  signal: AbortSignal = new AbortController().signal,
): Promise<Uint8Array> => {
  const outputs = await Promise.all(
    plan.segments.map((segment) =>
      segment.kind === "script" ? run(segment.id, signal) : undefined,
    ),
  );
  return concat(
    plan.segments.map((segment, i) =>
      segment.kind === "static"
        ? segment.bytes
        : encoder.encode(outputs[i] ?? ""),
    ),
  );
};

export interface StreamComposeOptions {
  /** Upstream cancellation (client disconnect, host deadline). */
  signal?: AbortSignal;
  /** Called once per `stream` job that fails after commit. */
  onStreamError?: (error: unknown, id: string) => void;
}

export interface ComposedStreamer {
  /** Resolves once every `server` job has resolved; rejects if one throws. */
  ready: Promise<void>;
  /** Called exactly once after `ready` and after headers are committed. */
  commit(): void;
  /** Resolves once every segment has been written (or the signal aborted). */
  done: Promise<void>;
  /** The request-lifetime signal every job observes. */
  signal: AbortSignal;
  /**
   * A Web `ReadableStream` body. Calling it commits: the first pull begins the
   * walk. Demand is honored (each write awaits the controller's desire), and
   * reader cancellation aborts every remaining job. Only valid when the
   * streamer was created without a writer.
   */
  toReadableStream(): ReadableStream<Uint8Array>;
}

/**
 * Two-phase streamed composition. See the module comment for the contract.
 *
 * Pass a `writer` to drive a host sink directly, or omit it and call
 * `toReadableStream()` to obtain a `Response` body. In the second form the
 * host must NOT await `done` before returning the `Response`: the body is
 * demand-gated and cannot flow until a reader exists.
 */
export const streamComposedResponse = (
  plan: ExecutionPlan,
  run: ScriptJobRunner,
  writer: StreamWriter | undefined,
  options: StreamComposeOptions = {},
): ComposedStreamer => {
  const abort = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) abort.abort(options.signal.reason);
    else
      options.signal.addEventListener(
        "abort",
        () => abort.abort(options.signal!.reason),
        { once: true },
      );
  }
  const signal = abort.signal;

  const serverOutputs = new Map<number, Promise<string>>();
  for (let i = 0; i < plan.segments.length; i++) {
    const segment = plan.segments[i];
    if (segment.kind === "script" && segment.mode === "server") {
      serverOutputs.set(i, run(segment.id, signal));
    }
  }
  const ready = Promise.all(serverOutputs.values()).then(() => undefined);

  let releaseCommit!: () => void;
  const committed = new Promise<void>((resolve) => {
    releaseCommit = resolve;
  });

  // The writer is chosen at commit time for the ReadableStream form.
  let activeWriter: StreamWriter | undefined = writer;

  const runStreamJob = async (
    segment: ScriptExecutionSegment,
  ): Promise<string> => {
    try {
      return await run(segment.id, signal);
    } catch (err) {
      if (signal.aborted) return "";
      options.onStreamError?.(err, segment.id);
      return "";
    }
  };

  const done = (async () => {
    try {
      await ready;
    } catch {
      return;
    }
    await committed;
    if (!activeWriter) return;
    const sink = activeWriter;

    const streamIndices: number[] = [];
    for (let i = 0; i < plan.segments.length; i++) {
      const segment = plan.segments[i];
      if (segment.kind === "script" && segment.mode === "stream")
        streamIndices.push(i);
    }
    const streamOutputs = new Map<number, Promise<string>>();
    let nextDue = 0;
    let nextToDispatch = 0;
    const dispatchWindow = (cursor: number): void => {
      while (nextDue < streamIndices.length && streamIndices[nextDue] < cursor)
        nextDue++;
      const limit = Math.min(
        streamIndices.length,
        nextDue + STREAM_LOOKAHEAD + 1,
      );
      while (nextToDispatch < limit) {
        if (signal.aborted) return;
        const index = streamIndices[nextToDispatch++];
        streamOutputs.set(
          index,
          runStreamJob(plan.segments[index] as ScriptExecutionSegment),
        );
      }
    };

    for (let i = 0; i < plan.segments.length; i++) {
      if (signal.aborted) return;
      dispatchWindow(i);
      const segment = plan.segments[i];
      if (segment.kind === "static") {
        await sink.write(segment.bytes);
        continue;
      }
      const output = await (segment.mode === "server"
        ? serverOutputs.get(i)!
        : streamOutputs.get(i)!);
      if (signal.aborted) return;
      if (output) await sink.write(encoder.encode(output));
    }
  })();

  const toReadableStream = (): ReadableStream<Uint8Array> => {
    if (writer)
      throw new Error(
        "toReadableStream() is only available when no writer was supplied.",
      );
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    // Demand gate: each write waits until the reader has asked for more.
    let demand = Promise.resolve();
    let signalDemand: (() => void) | undefined;
    const waitForDemand = (): Promise<void> => {
      if (controller.desiredSize !== null && controller.desiredSize > 0)
        return Promise.resolve();
      demand = new Promise<void>((resolve) => {
        signalDemand = resolve;
      });
      return demand;
    };
    activeWriter = {
      async write(chunk) {
        if (signal.aborted) return;
        await waitForDemand();
        if (signal.aborted) return;
        controller.enqueue(chunk);
      },
    };
    const stream = new ReadableStream<Uint8Array>(
      {
        start(c) {
          controller = c;
        },
        pull() {
          signalDemand?.();
          signalDemand = undefined;
        },
        cancel(reason) {
          abort.abort(
            reason instanceof Error ? reason : new Error("reader canceled"),
          );
          signalDemand?.();
        },
      },
      { highWaterMark: 1 },
    );
    releaseCommit();
    void done.then(
      () => {
        if (!signal.aborted) {
          try {
            controller.close();
          } catch {
            /* already closed by cancel */
          }
        }
      },
      (err) => {
        try {
          controller.error(err);
        } catch {
          /* already closed */
        }
      },
    );
    return stream;
  };

  return { ready, commit: releaseCommit, done, signal, toReadableStream };
};

// ─── Deadline-bounded invocation ─────────────────────────────────────────────

/** The subset of a clock the core needs. `FrameworkClock` satisfies it. */
export interface DeadlineClock {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const ambientClock: DeadlineClock = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface InvokeOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  clock?: DeadlineClock;
}

export interface InvokeResult<T> {
  ok: boolean;
  /** Present when `ok`. */
  value?: T;
  /** Present when not `ok`. */
  error?: Error;
  /**
   * Present when not `ok`: the raw rejection before it was wrapped as
   * `error`. A non-Error rejection keeps only its `String()` form in `error`,
   * so a field such as a reset `code` is read from here.
   */
  thrown?: unknown;
  timedOut: boolean;
  aborted: boolean;
}

const toError = (raw: unknown): Error =>
  raw instanceof Error ? raw : new Error(String(raw));

/** The message a timed-out server, stream or component script reports on every host. */
export const scriptTimeoutError = (timeoutMs: number): Error =>
  new Error(`Script execution timed out after ${timeoutMs}ms`);

const handlerTimeoutError = (timeoutMs: number): Error =>
  new Error(`Handler timed out after ${timeoutMs}ms`);

/**
 * The one rule every host settles a deadline-bounded call by: once the signal
 * has aborted (a fired deadline or an upstream abort), the abort is the
 * outcome, even when the work settles afterwards, including synchronously
 * inside its own abort listener. Work that settled before the abort keeps its
 * value or error, even when the abort lands in the same tick.
 *
 * Settlement of a native promise is only visible one microtask after it
 * happens, so both sides are compared by microtask order: the gate's abort
 * listener is registered before the work can add its own, and it queues the
 * abort decision before any listener of the work can settle. A settlement
 * that happened earlier queued its reaction earlier and wins; one that
 * happened during or after the abort queued it later and loses. A plain
 * `Promise.race` against an abort promise cannot do this: rejecting that
 * promise costs an extra microtask, so a value resolved inside the listener
 * won the race on Node.
 */
export interface AbortGate {
  /**
   * Settle with `work`, unless the signal's abort is decided first. One race
   * is pending at a time: start the next once the previous one settled.
   */
  race<T>(work: Promise<T>): Promise<T>;
  /** True once the abort was decided ahead of a settlement. */
  readonly decided: boolean;
  dispose(): void;
}

class SignalAbortGate implements AbortGate {
  decided: boolean;
  // The pending race's reject. A promise settles once, so whichever of the
  // work's reaction and the abort decision calls first wins and the other is
  // a no-op; no flag or waiter set is needed on this per-request path.
  private pending: ((reason: unknown) => void) | undefined = undefined;
  private readonly signal: AbortSignal;
  private readonly onAbort = (): void => {
    queueMicrotask(this.decide);
  };
  private readonly decide = (): void => {
    this.decided = true;
    const reject = this.pending;
    this.pending = undefined;
    reject?.(this.signal.reason);
  };

  constructor(signal: AbortSignal) {
    this.signal = signal;
    this.decided = signal.aborted;
    if (!this.decided) {
      signal.addEventListener("abort", this.onAbort, { once: true });
    }
  }

  race<T>(work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      // Attached even when already decided, so a late rejection of the work
      // is observed instead of surfacing as unhandled.
      if (this.decided) reject(this.signal.reason);
      else this.pending = reject;
      work.then(resolve, reject);
    });
  }

  dispose(): void {
    this.signal.removeEventListener("abort", this.onAbort);
    this.pending = undefined;
  }
}

export const createAbortGate = (signal: AbortSignal): AbortGate =>
  new SignalAbortGate(signal);

export interface LoadedInvokeOptions extends InvokeOptions {
  /** The error a fired deadline reports; defaults to "Handler timed out". */
  timeoutError?: (timeoutMs: number) => Error;
}

/** Run `produce` and gate its result; a synchronous throw is a rejection. */
const gated = <V>(
  gate: AbortGate,
  produce: () => V | Promise<V>,
): Promise<V> => {
  let work: Promise<V>;
  try {
    work = Promise.resolve(produce());
  } catch (syncErr) {
    work = Promise.reject(syncErr);
  }
  return gate.race(work);
};

/**
 * `invokeWithDeadline` with a load step under the same deadline: `load` runs
 * first, then `call` with its result. The handler's own promise is gated
 * directly rather than through an async wrapper, whose extra microtasks
 * would turn a value settled just before the deadline into a timeout.
 */
export const invokeLoadedWithDeadline = async <M, T>(
  load: (() => M | Promise<M>) | undefined,
  call: (loaded: M, options: { signal: AbortSignal }) => T | Promise<T>,
  options: LoadedInvokeOptions = {},
): Promise<InvokeResult<T>> => {
  const { timeoutMs, signal: upstream, clock = ambientClock } = options;
  const controller = new AbortController();
  const signal = controller.signal;
  // First listener on the signal, ahead of any the handler adds (see AbortGate).
  const gate = createAbortGate(signal);
  let unsubscribe: (() => void) | undefined;
  if (upstream) {
    if (upstream.aborted) controller.abort(upstream.reason);
    else {
      const onAbort = () => controller.abort(upstream.reason);
      upstream.addEventListener("abort", onAbort, { once: true });
      unsubscribe = () => upstream.removeEventListener("abort", onAbort);
    }
  }
  let timer: unknown;
  // Set only when the deadline, not an upstream abort, aborted the signal.
  let deadlineAborted = false;
  if (timeoutMs && timeoutMs > 0) {
    timer = clock.setTimeout(() => {
      if (signal.aborted) return;
      deadlineAborted = true;
      controller.abort(
        (options.timeoutError ?? handlerTimeoutError)(timeoutMs),
      );
    }, timeoutMs);
  }
  // An abort seen before the handler runs needs no race to win.
  let abortedBeforeCall = false;
  try {
    if (signal.aborted) {
      abortedBeforeCall = true;
      throw signal.reason;
    }
    const loaded = load ? await gated(gate, load) : (undefined as M);
    if (signal.aborted) {
      abortedBeforeCall = true;
      throw signal.reason;
    }
    const value = await gated(gate, () => call(loaded, { signal }));
    return { ok: true, value, timedOut: false, aborted: false };
  } catch (raw) {
    // Only an abort that won the race is a timeout or an abort; a handler's
    // own failure that settled first is reported as that failure.
    const abortWon =
      abortedBeforeCall || (gate.decided && raw === signal.reason);
    return {
      ok: false,
      error: toError(raw),
      thrown: raw,
      timedOut: abortWon && deadlineAborted,
      aborted: abortWon && !deadlineAborted,
    };
  } finally {
    gate.dispose();
    if (timer !== undefined) clock.clearTimeout(timer);
    unsubscribe?.();
  }
};

/**
 * Invoke `handler` under a deadline and an upstream signal. Settles exactly
 * once; a late rejection after settlement is observed and discarded. A
 * pre-aborted upstream signal never invokes the handler. Once the deadline
 * fired or the upstream aborted, the outcome is a timeout or an abort even if
 * the handler settles afterwards (see `AbortGate`). `ScriptRegistry.invoke`,
 * `executeApiRoute` and the Worker settle through the same rule.
 */
export const invokeWithDeadline = <T>(
  handler: (options: { signal: AbortSignal }) => T | Promise<T>,
  options: InvokeOptions = {},
): Promise<InvokeResult<T>> =>
  invokeLoadedWithDeadline(undefined, (_, o) => handler(o), options);

// ─── API route method dispatch ───────────────────────────────────────────────

export const ALLOWED_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "HEAD",
] as const;
export type HttpMethod = (typeof ALLOWED_METHODS)[number];

/** Context every API route handler receives as its second argument. */
export interface ApiHandlerContext {
  /** `[param]` values are strings; a `[...rest]` catch-all value is a decoded `string[]`. */
  params: Record<string, string | string[]>;
  remoteIp: string;
  /** Host capabilities (prompt 131 decision). `undefined` on hosts that offer none. */
  platform?: PlatformContext;
}

/**
 * Host capability injection. Additive and optional: a handler that never
 * reads `context.platform` runs unchanged on every host. Adapters set `name`
 * and whatever the provider exposes; no globals, no `process.env` mutation.
 */
export interface PlatformContext {
  name: string;
  /** Provider bindings and secrets (Cloudflare `env`). */
  env?: Record<string, unknown>;
  /** Provider background-work hook (Cloudflare `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** The platform context the built-in Node server passes: no bindings, no waitUntil. */
export const NODE_PLATFORM: PlatformContext = Object.freeze({ name: "node" });

export type ApiHandlerModule = Record<string, unknown>;

export interface DispatchOptions extends InvokeOptions {
  /** Server-side diagnostics only; never reaches the client. */
  onError?: (message: string, error?: unknown) => void;
  /**
   * Host hook run before the generic 500 mapping. Return a `Response` to own
   * a transport-specific failure (Node maps its body-limit error to 413 and a
   * socket reset to 499 here); return `undefined` to fall through.
   */
  classifyError?: (error: unknown) => Response | undefined;
}

const text = (
  body: string,
  status: number,
  headers: Record<string, string> = {},
): Response =>
  new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...headers },
  });

/** Sorted `Allow` header value for a module: exported methods plus derived HEAD and auto OPTIONS. */
export const allowHeaderFor = (mod: ApiHandlerModule): string => {
  const allow = new Set<string>();
  for (const m of ALLOWED_METHODS)
    if (typeof mod[m] === "function") allow.add(m);
  if (allow.has("GET")) allow.add("HEAD");
  allow.add("OPTIONS");
  return Array.from(allow).sort().join(", ");
};

/**
 * Method dispatch with the exact policy the Node runtime documents:
 * allowlist 405 + Allow, derived HEAD, auto OPTIONS 204 without CORS,
 * generic 500 for throws and non-Response returns, 504 on deadline, 499 on
 * upstream abort. No Node-only headers (`Connection`, `Transfer-Encoding`)
 * are added to the Web `Response`; hosts add transport headers themselves.
 */
export const dispatchApiHandler = async (
  mod: ApiHandlerModule,
  request: Request,
  context: ApiHandlerContext,
  options: DispatchOptions = {},
): Promise<Response> => {
  const requested = request.method.toUpperCase();
  const allow = allowHeaderFor(mod);
  // The allowlist comes first: an export named PURGE, or a helper that only
  // looks like a method, is never dispatched, so `Allow` stays accurate.
  if (!(ALLOWED_METHODS as readonly string[]).includes(requested))
    return text("Method Not Allowed", 405, { Allow: allow });
  const method = requested as HttpMethod;
  const isAllowed =
    typeof mod[method] === "function" ||
    (method === "HEAD" && typeof mod.GET === "function") ||
    method === "OPTIONS";
  if (!isAllowed) return text("Method Not Allowed", 405, { Allow: allow });
  if (method === "OPTIONS" && typeof mod.OPTIONS !== "function") {
    return new Response(null, { status: 204, headers: { Allow: allow } });
  }
  let handler = mod[method] as (...args: unknown[]) => unknown;
  let derivedHead = false;
  if (method === "HEAD" && typeof mod.HEAD !== "function") {
    handler = mod.GET as typeof handler;
    derivedHead = true;
  }

  const result = await invokeWithDeadline(
    ({ signal }) => handler(request, context, { signal }),
    options,
  );
  if (!result.ok) {
    const error = result.error ?? new Error("API route handler failed");
    const owned = options.classifyError?.(error);
    if (owned) return owned;
    if (result.timedOut) {
      options.onError?.(
        `API route handler timed out (${method} ${new URL(request.url).pathname}) after ${options.timeoutMs}ms`,
      );
      return text("Gateway Timeout", 504);
    }
    if (result.aborted) return text("Client Closed Request", 499);
    options.onError?.(
      `API route handler error (${method} ${new URL(request.url).pathname})`,
      error,
    );
    return text("Internal Server Error", 500);
  }
  const value = result.value;
  if (!(value instanceof Response)) {
    options.onError?.(
      `API route handler (${method} ${new URL(request.url).pathname}) did not return a Response. Returned: ${typeof value}`,
    );
    return text("Internal Server Error", 500);
  }
  if (derivedHead) {
    return new Response(null, {
      status: value.status,
      statusText: value.statusText,
      headers: value.headers,
    });
  }
  return value;
};
