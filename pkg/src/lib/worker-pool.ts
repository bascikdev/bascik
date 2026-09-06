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
}

/** Maximum consecutive workers that die before a first completion. Bounds
 * respawn: a persistently broken worker module never spins forever. */
const MAX_STARTUP_ATTEMPTS = 4;

const NO_VIABLE_REQUEST =
  "WorkerPool has no viable workers: worker startup failed repeatedly; check the worker module";

/**
 * Fixed-size pool of worker threads. Each worker is initialized once with
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
  #capacityExhausted = false;
  #consecutiveStartupFailures: number;

  constructor(workerScript: string, size: number, initData: unknown) {
    this.#workerScript = workerScript;
    this.#initData = initData;
    this.#consecutiveStartupFailures = 0;
    for (let i = 0; i < size; i++) {
      this.#spawn();
    }
  }

  #spawn(): void {
    if (this.#terminated || this.#capacityExhausted) return;
    let worker: Worker;
    try {
      const execArgv = process.execArgv.filter((arg) => !arg.startsWith("--input-type"));
      worker = new Worker(this.#workerScript, {
        workerData: this.#initData,
        execArgv,
      });
    } catch (error) {
      // Constructor failure (missing/unloadable module). Treat as a startup
      // failure so a broken worker never triggers an endless respawn loop.
      this.#noteStartupFailure();
      return;
    }
    const slot: Slot<Task, Result> = { worker, pending: null, completedAny: false };
    this.#slots.push(slot);
    worker.on("message", (message: any) => this.#onMessage(slot, message));
    worker.on("error", (error: Error) => this.#onError(slot, error));
    worker.on("exit", (code: number) => this.#onExit(slot, code));
    this.#addIdle(slot);
    this.#dispatchFrom(slot);
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
    slot.worker.terminate().catch(() => { });
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

  run(task: Task): Promise<Result> {
    return new Promise<Result>((resolve, reject) => {
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

  async terminate(): Promise<void> {
    this.#terminated = true;
    // Reject everything still queued so no caller is left hanging.
    for (const job of this.#queue.splice(0)) {
      job.reject(new Error("WorkerPool terminated before task ran"));
    }
    // Reject every in-flight task exactly once.
    const inFlight: QueuedTask<Task, Result>[] = [];
    for (const slot of this.#slots) {
      if (slot.pending) inFlight.push(slot.pending);
      slot.pending = null;
    }
    for (const job of inFlight) {
      job.reject(new Error("WorkerPool terminated while task was in flight"));
    }
    await Promise.all(this.#slots.map((s) => s.worker.terminate()));
    this.#slots = [];
    this.#idleSlots = [];
  }
}
