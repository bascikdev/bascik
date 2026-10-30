import { Worker } from "node:worker_threads";

interface QueuedTask<Task, Result> {
  task: Task;
  resolve: (value: Result) => void;
  reject: (error: unknown) => void;
}

/**
 * A live worker slot. Each worker owns at most one task at a time (its
 * `pending` job) and is tracked in `#slots` until it is retired exactly once.
 * `completedAny` records whether the worker ever finished a job, which proves
 * the worker module is viable; a worker that dies before its first completion
 * is treated as a possible startup failure (bounded respawn).
 */
interface Slot<Task, Result> {
  worker: Worker;
  pending: QueuedTask<Task, Result> | null;
  completedAny: boolean;
  /** Settles once the worker has loaded (`readySignal`) or has exited. */
  loaded: Promise<void>;
  markLoaded: () => void;
}

/** The message a `readySignal` worker posts once its script has loaded. */
const READY_MESSAGE_KEY = "ready";

/** How long stopping a `readySignal` worker waits for it to load before
 * terminating it anyway, so a worker stuck loading cannot hang shutdown. */
const READY_GRACE_MS = 10_000;

/** Maximum consecutive workers that die before a first completion. Bounds
 * respawn: a persistently broken worker module never spins forever. */
const MAX_STARTUP_ATTEMPTS = 4;

const NO_VIABLE_REQUEST =
  "WorkerPool has no viable workers: worker startup failed repeatedly; check the worker module";

/** Zero workers would strand every queued task forever. */
const assertPoolSize = (size: number): void => {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`WorkerPool size must be at least 1, got ${size}`);
  }
};

/**
 * Pool of worker threads, resized only by `shrink` and `grow`. Each worker is initialized once with
 * `initData` (via `workerData`) and then reused for many `run()` calls,
 * avoiding the cost of re-spawning a worker (and re-running its module
 * top-level code) per task.
 *
 * Lifecycle: every task settles exactly once, on success, failure, unexpected
 * exit, or termination. Any unexpected exit of a tracked worker invalidates
 * its capacity regardless of exit code: the failing active task is rejected
 * (never auto-replayed, since its side effects may already have run) and
 * untouched queued tasks are dispatched to a replacement worker while live.
 */
export class WorkerPool<Task, Result> {
  #workerScript: string;
  #initData: unknown;
  #slots: Slot<Task, Result>[] = [];
  #idleSlots: Slot<Task, Result>[] = [];
  #queue: QueuedTask<Task, Result>[] = [];
  #terminated = false;
  /** Terminated with `abandon`: tasks are dropped, never settled. */
  #abandoned = false;
  #capacityExhausted = false;
  #consecutiveStartupFailures: number;
  /** Most workers the pool keeps, set by `shrink` and `grow`. A replacement
   * for a crashed worker restores capacity only up to it. */
  #capacity: number;
  /** Every `configure` message so far, replayed in order to every worker
   * spawned later. */
  #settings: unknown[] = [];
  /** Terminations started by `shrink`, awaited by `terminate`. */
  #trimming = new Set<Promise<unknown>>();

  #env: NodeJS.ProcessEnv | undefined;
  #readySignal: boolean;

  /**
   * `readySignal`: the worker script posts `{ ready: true }` once its module
   * graph has finished evaluating, and the pool never terminates a worker
   * before that (or before `READY_GRACE_MS`). Node 24 can abort the whole
   * process ("Check failed: (location_) != nullptr") when a worker is
   * terminated while it is still evaluating ES modules with top-level await,
   * and a pool that is started early and trimmed, or torn down after a
   * failure, can otherwise stop workers that are still loading.
   */
  constructor(
    workerScript: string,
    size: number,
    initData: unknown,
    options: { env?: NodeJS.ProcessEnv; readySignal?: boolean } = {},
  ) {
    this.#env = options.env;
    this.#readySignal = options.readySignal ?? false;
    this.#workerScript = workerScript;
    this.#initData = initData;
    this.#consecutiveStartupFailures = 0;
    this.#capacity = size;
    for (let i = 0; i < size; i++) {
      this.#spawn();
    }
  }

  #spawn(): void {
    if (this.#terminated || this.#capacityExhausted) return;
    let worker: Worker;
    try {
      const execArgv = process.execArgv.filter(
        (arg) => !arg.startsWith("--input-type"),
      );
      worker = new Worker(this.#workerScript, {
        workerData: this.#initData,
        execArgv,
        // Only passed when asked for. Omitting it keeps the default: a copy of this thread's environment.
        ...(this.#env ? { env: this.#env } : {}),
      });
    } catch (error) {
      // Constructor failure (missing/unloadable module). Treat as a startup
      // failure so a broken worker never triggers an endless respawn loop.
      this.#noteStartupFailure();
      return;
    }
    let markLoaded!: () => void;
    const loaded = this.#readySignal
      ? new Promise<void>((resolve) => (markLoaded = resolve))
      : Promise.resolve();
    const slot: Slot<Task, Result> = {
      worker,
      pending: null,
      completedAny: false,
      loaded,
      markLoaded: () => markLoaded?.(),
    };
    this.#slots.push(slot);
    worker.on("message", (message: any) => {
      // Before the liveness checks: a trimmed or terminating worker's ready
      // signal is exactly what its pending stop is waiting for.
      if (this.#readySignal && message?.[READY_MESSAGE_KEY] === true) {
        slot.markLoaded();
        return;
      }
      this.#onMessage(slot, message);
    });
    worker.on("error", (error: Error) => this.#onError(slot, error));
    worker.on("exit", (code: number) => {
      // A worker that exited will never signal; nothing should wait for it.
      slot.markLoaded();
      this.#onExit(slot, code);
    });
    // The port is FIFO, so settings posted before the first task are applied
    // before it: a replacement never runs a task under the stale settings it
    // was spawned with.
    for (const message of this.#settings) {
      if (!this.#post(slot, message)) return;
    }
    this.#addIdle(slot);
    this.#dispatchFrom(slot);
  }

  /** Post a non-task message; on failure retire the worker (as a dispatch
   * failure would) and report false. */
  #post(slot: Slot<Task, Result>, message: unknown): boolean {
    try {
      slot.worker.postMessage(message);
      return true;
    } catch {
      this.#retire(slot);
      return false;
    }
  }

  #onMessage(slot: Slot<Task, Result>, message: any): void {
    if (this.#terminated || !this.#isLive(slot)) return;
    const job = slot.pending;
    slot.pending = null;
    if (job) {
      // A completed job proves the module is viable; a later crash is a normal
      // retirement replaced unconditionally.
      slot.completedAny = true;
      this.#consecutiveStartupFailures = 0;
      if (message.ok) job.resolve(message.result);
      else job.reject(new Error(message.error));
    }
    // A worker left over after `shrink` lowered the capacity while it was busy.
    if (this.#slots.length > this.#capacity) {
      this.#trim(slot);
      return;
    }
    this.#addIdle(slot);
    this.#dispatchFrom(slot);
  }

  #onError(slot: Slot<Task, Result>, error: Error): void {
    if (this.#terminated || !this.#isLive(slot)) return;
    const job = slot.pending;
    slot.pending = null;
    job?.reject(error);
    this.#retire(slot);
  }

  #onExit(slot: Slot<Task, Result>, code: number): void {
    if (this.#terminated || !this.#isLive(slot)) return;
    const job = slot.pending;
    slot.pending = null;
    // Unexpected exit invalidates capacity regardless of exit code (a clean
    // exit(0) still kills the worker's ability to finish its current task).
    job?.reject(new Error(`Worker exited with code ${code}`));
    this.#retire(slot);
  }

  /** Is the slot still tracked (not already retired)? */
  #isLive(slot: Slot<Task, Result>): boolean {
    return this.#slots.includes(slot);
  }

  /**
   * Retire a worker exactly once: drop it from every tracking structure,
   * best-effort terminate its thread, then replace capacity while live. A
   * worker that completed at least one task is proven viable and is always
   * replaced; one that died before its first completion is counted toward the
   * bounded-startup-failure budget.
   */
  #retire(slot: Slot<Task, Result>): void {
    if (this.#terminated) return;
    slot.pending = null;
    this.#slots = this.#slots.filter((s) => s !== slot);
    this.#idleSlots = this.#idleSlots.filter((s) => s !== slot);
    void this.#stop(slot);
    // Never refill above the capacity `shrink` set (the slot is already gone
    // from `#slots`, so this is the count without it).
    if (this.#slots.length >= this.#capacity) return;
    if (slot.completedAny) {
      this.#consecutiveStartupFailures = 0;
      this.#spawn();
    } else {
      this.#noteStartupFailure();
    }
  }

  /** Count a dead-before-first-completion worker. Bound the budget; once spent,
   * stop respawning and settle queued callers instead of stranding them. */
  #noteStartupFailure(): void {
    if (this.#terminated || this.#capacityExhausted) return;
    this.#consecutiveStartupFailures += 1;
    if (this.#consecutiveStartupFailures >= MAX_STARTUP_ATTEMPTS) {
      this.#capacityExhausted = true;
      this.#settleAllQueued(new Error(NO_VIABLE_REQUEST));
    } else {
      this.#spawn();
    }
  }

  /** Reject every queued caller with `error` so none waits forever. */
  #settleAllQueued(error: Error): void {
    for (const job of this.#queue.splice(0)) {
      job.reject(error);
    }
  }

  #addIdle(slot: Slot<Task, Result>): void {
    if (!this.#idleSlots.includes(slot)) this.#idleSlots.push(slot);
  }

  /** Live workers, busy or idle. */
  get size(): number {
    return this.#slots.length;
  }

  /**
   * Lower the pool to at most `size` workers. Idle surplus workers are
   * terminated now; a busy one finishes its task first. Nothing trimmed is
   * replaced, and a later crash is replaced only up to `size`. Lets a caller
   * start workers before it knows how much work there is (so their startup
   * overlaps whatever finds the work) and then give back the ones it does not
   * need, instead of keeping idle threads and their memory alive.
   *
   * The trimmed workers stop from the pool's point of view at once; the
   * returned promise (which never rejects) settles when their threads have
   * exited. Callers should not wait for it before running tasks: a thread
   * busy loading modules can take a couple of hundred milliseconds to stop,
   * and `terminate()` waits for it anyway.
   */
  shrink(size: number): Promise<void> {
    assertPoolSize(size);
    if (size < this.#capacity) {
      this.#capacity = size;
      for (const slot of [...this.#idleSlots]) {
        if (this.#slots.length <= this.#capacity) break;
        this.#trim(slot);
      }
    }
    return Promise.all(this.#trimming).then(() => {});
  }

  /**
   * Raise the pool to at least `size` workers, spawning the missing ones now.
   * The counterpart of `shrink` for a caller that started fewer workers than
   * it turns out to need: starting at a lower bound and growing never spends
   * a thread (and its module load) on work that does not exist, which
   * starting at an upper bound and trimming would. New workers get every
   * `configure` message before their first task, like a replacement does.
   * Does nothing once the pool is terminated or its workers have failed to
   * start repeatedly.
   */
  grow(size: number): void {
    assertPoolSize(size);
    if (this.#terminated || this.#capacityExhausted) return;
    if (size <= this.#capacity) return;
    this.#capacity = size;
    while (
      this.#slots.length < this.#capacity &&
      !this.#terminated &&
      !this.#capacityExhausted
    ) {
      const before = this.#slots.length;
      this.#spawn();
      // A spawn that throws is counted as a startup failure and may already
      // have been retried; stop if this round added nothing, so a broken
      // module cannot spin here.
      if (this.#slots.length === before) break;
    }
  }

  /** Drop a worker without replacing it or counting it as a failure. Its
   * later exit event finds it untracked and is ignored. */
  #trim(slot: Slot<Task, Result>): void {
    this.#slots = this.#slots.filter((s) => s !== slot);
    this.#idleSlots = this.#idleSlots.filter((s) => s !== slot);
    const stopped = this.#stop(slot);
    this.#trimming.add(stopped);
    void stopped.then(() => this.#trimming.delete(stopped));
  }

  /**
   * Terminate a worker once it is safe to (see `readySignal`): at once
   * without the option or once it has loaded, after the grace period at the
   * latest. Never rejects.
   */
  async #stop(slot: Slot<Task, Result>): Promise<void> {
    await this.#stopForTerminate(slot).catch(() => {});
  }

  /** As `#stop`, but a rejecting `worker.terminate()` reaches the caller
   * (the `terminate()` contract). */
  async #stopForTerminate(slot: Slot<Task, Result>): Promise<number> {
    if (!this.#readySignal) return slot.worker.terminate();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      slot.loaded,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, READY_GRACE_MS);
      }),
    ]);
    clearTimeout(timer);
    return slot.worker.terminate();
  }

  /**
   * Post `message` to every live worker now, and to every worker spawned
   * later before its first task, after the messages configured before it.
   * Lets a caller start workers before it has everything they need (they
   * load their modules meanwhile) and hand it over once it does. The worker
   * script must treat it as settings and not reply: a reply would be taken
   * for a task's result.
   */
  configure(message: unknown): void {
    if (this.#terminated) return;
    this.#settings.push(message);
    for (const slot of [...this.#slots]) this.#post(slot, message);
  }

  run(task: Task): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
      if (this.#abandoned) return;
      if (this.#terminated) {
        reject(new Error("WorkerPool has been terminated"));
        return;
      }
      if (this.#capacityExhausted) {
        reject(new Error(NO_VIABLE_REQUEST));
        return;
      }
      this.#queue.push({ task, resolve, reject });
      const slot = this.#idleSlots.pop();
      if (slot) this.#dispatchFrom(slot);
    });
  }

  #dispatchFrom(slot: Slot<Task, Result>): void {
    if (this.#terminated || this.#capacityExhausted) return;
    const job = this.#queue.shift();
    if (!job) {
      this.#addIdle(slot);
      return;
    }
    // A slot with a pending task is busy, so it must not stay in the idle list: a later
    // `run()` would pop it and overwrite this job, which would then never settle.
    this.#idleSlots = this.#idleSlots.filter((s) => s !== slot);
    slot.pending = job;
    try {
      slot.worker.postMessage(job.task);
    } catch (error) {
      // postMessage failed before delivery, so the task's side effects cannot
      // have run. Put it back on the queue for a replacement worker instead of
      // stranding it, then retire the unusable worker.
      slot.pending = null;
      this.#queue.unshift(job);
      this.#retire(slot);
    }
  }

  /**
   * Stop every worker (each only once it has loaded, with `readySignal`).
   * Queued and in-flight tasks are rejected, so no caller is left hanging.
   *
   * `abandon`: for a process that is about to exit. The tasks are dropped
   * without settling, and so is every later `run`, so the caller does not
   * report its own work as failed while the exit waits for the workers: the
   * reason for the exit (a crash, a Ctrl-C) stays the only thing reported.
   */
  async terminate(options: { abandon?: boolean } = {}): Promise<void> {
    this.#terminated = true;
    if (options.abandon) this.#abandoned = true;
    const queued = this.#queue.splice(0);
    const inFlight: QueuedTask<Task, Result>[] = [];
    for (const slot of this.#slots) {
      if (slot.pending) inFlight.push(slot.pending);
      slot.pending = null;
    }
    if (!this.#abandoned) {
      for (const job of queued) {
        job.reject(new Error("WorkerPool terminated before task ran"));
      }
      // Each in-flight task exactly once.
      for (const job of inFlight) {
        job.reject(new Error("WorkerPool terminated while task was in flight"));
      }
    }
    await Promise.all([
      ...this.#slots.map((s) => this.#stopForTerminate(s)),
      ...this.#trimming,
    ]);
    this.#slots = [];
    this.#idleSlots = [];
  }
}
