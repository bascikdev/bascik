import { describe, it, expect, vi, beforeEach } from "vitest";
import { WorkerPool } from "./worker-pool.ts";

interface FakeWorker {
  emit: (event: string, ...args: unknown[]) => boolean;
  postMessage: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
}

const { workers, WorkerMock } = vi.hoisted(() => {
  // Minimal EventEmitter stand-in (the real node:events import is not
  // available inside vi.hoisted factories).
  class FakeWorkerImpl {
    #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    postMessage = vi.fn();
    terminate = vi.fn().mockResolvedValue(0);

    on(event: string, listener: (...args: unknown[]) => void): this {
      const list = this.#listeners.get(event) ?? [];
      list.push(listener);
      this.#listeners.set(event, list);
      return this;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const list = this.#listeners.get(event) ?? [];
      for (const listener of list) listener(...args);
      return list.length > 0;
    }
  }
  const workers: FakeWorkerImpl[] = [];
  const WorkerMock = vi.fn(function (this: FakeWorkerImpl) {
    const w = new FakeWorkerImpl();
    workers.push(w);
    return w;
  });
  return { workers, WorkerMock };
});

vi.mock("node:worker_threads", () => ({
  Worker: WorkerMock,
}));

const makePool = (size = 2) =>
  new WorkerPool<string, string>("/fake/worker.js", size, { init: true });

/** Simulate the worker successfully completing its current task. */
const completeWith = (worker: FakeWorker, result: string) => {
  worker.emit("message", { ok: true, result });
};

/** Simulate the worker reporting a task failure. */
const failWith = (worker: FakeWorker, error: string) => {
  worker.emit("message", { ok: false, error });
};

beforeEach(() => {
  workers.length = 0;
  WorkerMock.mockClear();
});

describe("WorkerPool", () => {
  it("spawns `size` workers with the script and init data", () => {
    makePool(3);
    expect(WorkerMock).toHaveBeenCalledTimes(3);
    expect(WorkerMock).toHaveBeenCalledWith("/fake/worker.js", {
      workerData: { init: true },
      execArgv: expect.any(Array),
    });
  });

  it("gives workers the environment it was handed, and leaves the default alone when it was not", () => {
    new WorkerPool<string, string>(
      "/fake/worker.js",
      1,
      {},
      { env: { FORCE_COLOR: "1" } },
    );
    expect(WorkerMock).toHaveBeenLastCalledWith(
      "/fake/worker.js",
      expect.objectContaining({ env: { FORCE_COLOR: "1" } }),
    );
    WorkerMock.mockClear();
    makePool(1);
    expect((WorkerMock.mock.calls[0] as unknown[])[1]).not.toHaveProperty(
      "env",
    );
  });

  it("dispatches tasks to idle workers and resolves with the result", async () => {
    const pool = makePool(1);
    const promise = pool.run("task-a");
    expect(workers[0].postMessage).toHaveBeenCalledWith("task-a");
    completeWith(workers[0], "done-a");
    await expect(promise).resolves.toBe("done-a");
    await pool.terminate();
  });

  it("rejects the task when the worker reports an error result", async () => {
    const pool = makePool(1);
    const promise = pool.run("task-a");
    failWith(workers[0], "boom");
    await expect(promise).rejects.toThrow("boom");
    await pool.terminate();
  });

  it("rejects in-flight task and respawns worker when worker exits unexpectedly", async () => {
    const pool = makePool(1);
    const promise = pool.run("task-a");
    workers[0].emit("exit", 1);
    await expect(promise).rejects.toThrow("Worker exited with code 1");
    expect(WorkerMock).toHaveBeenCalledTimes(2);
    await pool.terminate();
  });

  it("queues tasks when all workers are busy, dispatching in order", async () => {
    const pool = makePool(1);
    const first = pool.run("task-1");
    const second = pool.run("task-2");
    // Only one worker — second task stays queued until the first completes.
    expect(workers[0].postMessage).toHaveBeenCalledTimes(1);
    completeWith(workers[0], "r1");
    await expect(first).resolves.toBe("r1");
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2);
    expect(workers[0].postMessage).toHaveBeenLastCalledWith("task-2");
    completeWith(workers[0], "r2");
    await expect(second).resolves.toBe("r2");
    await pool.terminate();
  });

  it("does not hand a new task to a worker that already picked up a queued one", async () => {
    // A worker that finishes a task and immediately takes the next queued one is busy,
    // so a task submitted afterwards has to wait for it instead of replacing that job.
    const pool = makePool(1);
    const first = pool.run("task-1");
    const second = pool.run("task-2");
    completeWith(workers[0], "r1");
    await expect(first).resolves.toBe("r1");
    expect(workers[0].postMessage).toHaveBeenLastCalledWith("task-2");

    const third = pool.run("task-3");
    expect(workers[0].postMessage).toHaveBeenCalledTimes(2);

    completeWith(workers[0], "r2");
    await expect(second).resolves.toBe("r2");
    expect(workers[0].postMessage).toHaveBeenLastCalledWith("task-3");
    completeWith(workers[0], "r3");
    await expect(third).resolves.toBe("r3");
    await pool.terminate();
  });

  describe("error recovery", () => {
    it("rejects the in-flight task and spawns a replacement when a worker errors", async () => {
      const pool = makePool(1);
      const promise = pool.run("task-a");
      const crash = new Error("worker crashed");
      workers[0].emit("error", crash);
      await expect(promise).rejects.toThrow("worker crashed");
      // The dead worker is retired and replaced.
      expect(workers[0].terminate).toHaveBeenCalled();
      expect(WorkerMock).toHaveBeenCalledTimes(2);
      // The pool still works: the replacement worker serves new tasks.
      const next = pool.run("task-b");
      expect(workers[1].postMessage).toHaveBeenCalledWith("task-b");
      completeWith(workers[1], "recovered");
      await expect(next).resolves.toBe("recovered");
      await pool.terminate();
    });

    it("dispatches queued tasks to replacement worker when a worker crashes", async () => {
      const pool = makePool(1);
      const running = pool.run("task-1");
      const queued = pool.run("task-2");
      // task-2 is in queue because pool size is 1 and worker 0 is processing task-1
      const crash = new Error("worker crashed on task-1");
      workers[0].emit("error", crash);
      await expect(running).rejects.toThrow("worker crashed on task-1");

      // Replacement worker 1 should automatically be dispatched queued task-2
      expect(workers[1].postMessage).toHaveBeenCalledWith("task-2");
      completeWith(workers[1], "queued-done");
      await expect(queued).resolves.toBe("queued-done");
      await pool.terminate();
    });

    it("does not spawn a replacement for a worker erroring after terminate()", async () => {
      const pool = makePool(1);
      const terminatePromise = pool.terminate();
      workers[0].emit("error", new Error("late crash"));
      await terminatePromise;
      expect(WorkerMock).toHaveBeenCalledTimes(1);
    });

    it("rejects the active task on a clean exit(0)", async () => {
      const pool = makePool(1);
      const promise = pool.run("task-a");
      workers[0].emit("exit", 0);
      await expect(promise).rejects.toThrow("Worker exited with code 0");
      await pool.terminate();
    });

    it("retires an idle clean exit(0) and restores capacity for a later run", async () => {
      const pool = makePool(1);
      workers[0].emit("exit", 0);
      // A replacement is spawned for the retired (never-completed) worker.
      expect(WorkerMock).toHaveBeenCalledTimes(2);
      const promise = pool.run("task-b");
      expect(workers[1].postMessage).toHaveBeenCalledWith("task-b");
      completeWith(workers[1], "done");
      await expect(promise).resolves.toBe("done");
      await pool.terminate();
    });

    it("does not spawn a replacement for a worker exiting after terminate()", async () => {
      const pool = makePool(1);
      const terminatePromise = pool.terminate();
      workers[0].emit("exit", 0);
      await terminatePromise;
      expect(WorkerMock).toHaveBeenCalledTimes(1);
    });

    it("does not dispatch after shutdown even when a retire loop would want a replacement", async () => {
      const pool = makePool(2);
      await pool.terminate();
      // Any post-terminate exit/error must neither spawn nor dispatch.
      workers[0].emit("exit", 0);
      workers[1].emit("error", new Error("late"));
      expect(WorkerMock).toHaveBeenCalledTimes(2);
      for (const worker of workers) {
        expect(worker.postMessage).not.toHaveBeenCalled();
      }
    });

    it("re-dispatch throws by requeueing the untouched task to the replacement worker", async () => {
      const pool = makePool(1);
      // First dispatch attempt fails before delivery; the task must not be
      // stranded and must not have any side effects on the dead worker.
      workers[0].postMessage.mockImplementationOnce(() => {
        throw new Error("cannot post");
      });
      const promise = pool.run("task-a");
      // The unusable worker is retired and a replacement is spawned.
      expect(WorkerMock).toHaveBeenCalledTimes(2);
      // The alternative is paid back to the replacement, which completes it.
      expect(workers[1].postMessage).toHaveBeenCalledWith("task-a");
      completeWith(workers[1], "delivered-via-replacement");
      await expect(promise).resolves.toBe("delivered-via-replacement");
      await pool.terminate();
    });

    it("bounded startup respawn: repeated dead-before-completion workers exhaust capacity and reject callers", async () => {
      const pool = makePool(1);
      // Drive every startup attempt to death before it completes a task.
      // MAX_STARTUP_ATTEMPTS (4) workers are spawned and each dies idle.
      for (const worker of workers) {
        worker.emit("exit", 1);
      }
      expect(WorkerMock).toHaveBeenCalledTimes(4);
      // No further respawn: capacity is exhausted.
      workers[0].emit("exit", 1);
      expect(WorkerMock).toHaveBeenCalledTimes(4);
      // New callers settle promptly with a useful error instead of hanging.
      await expect(pool.run("forever")).rejects.toThrow(/no viable workers/);
      await pool.terminate();
    });

    it("does not duplicate idle entries for a worker that reports message then exit", async () => {
      const pool = makePool(1);
      const first = pool.run("task-1");
      completeWith(workers[0], "r1");
      await expect(first).resolves.toBe("r1");
      // The completed worker is once again idle; a queued follow-up is served
      // by the same worker, so no separate replacement is spawned.
      const second = pool.run("task-2");
      expect(WorkerMock).toHaveBeenCalledTimes(1);
      expect(workers[0].postMessage).toHaveBeenLastCalledWith("task-2");
      completeWith(workers[0], "r2");
      await expect(second).resolves.toBe("r2");
      // A late exit for the (already completed) worker retires it cleanly.
      workers[0].emit("exit", 0);
      await pool.terminate();
    });

    it("settles exactly once when a worker posts a message and exits in the same tick", async () => {
      const pool = makePool(1);
      const running = pool.run("task-1");
      // The worker reports success and exits before the pool processes the next
      // task's event-loop turn. The settle must happen exactly once (via the
      // message path); the follow-up exit must NOT double-retire the slot or
      // double-dispatch to a wasted replacement, and the completed worker's
      // freed capacity must be restored exactly once.
      let resolves = 0;
      const first = running.then((r) => {
        resolves += 1;
        return r;
      });
      workers[0].emit("message", { ok: true, result: "r1" });
      workers[0].emit("exit", 0);
      await expect(first).resolves.toBe("r1");
      expect(resolves).toBe(1);
      // The completed worker is unambiguously retired exactly once. A queued
      // follow-up is served by one replacement worker (not a doubled one),
      // proving capacity was not double-added to idle nor double-retired.
      const second = pool.run("task-2");
      expect(WorkerMock).toHaveBeenCalledTimes(2);
      expect(workers[1]).toBeDefined();
      expect(workers[1].postMessage).toHaveBeenCalledWith("task-2");
      // No duplicate idle/dispatch on the retired worker; only workers[0] was
      // the original, workers[1] the single replacement.
      const dispatched = workers.filter(
        (w) => w.postMessage.mock.calls.length > 0,
      );
      expect(dispatched.map((w) => workers.indexOf(w))).toEqual([0, 1]);
      completeWith(workers[1], "r2");
      await expect(second).resolves.toBe("r2");
      await pool.terminate();
    });

    it("settles exactly once when a worker exits and posts a message in the same tick", async () => {
      const pool = makePool(1);
      const running = pool.run("task-1");
      const first = running.then((r) => r);
      // Reverse ordering: exit fires first (rejecting the active task), then a
      // late message. The late message must be ignored because the slot is no
      // longer live, so the reject happens exactly once and no replacement is
      // double-dispatching a stale assignment.
      workers[0].emit("exit", 0);
      expect(WorkerMock).toHaveBeenCalledTimes(2); // replacement spawned once
      workers[0].emit("message", { ok: true, result: "stale" });
      await expect(first).rejects.toThrow("Worker exited with code 0");
      // The next task is served by the single replacement.
      const second = pool.run("task-2");
      expect(workers[1].postMessage).toHaveBeenCalledWith("task-2");
      completeWith(workers[1], "recovered");
      await expect(second).resolves.toBe("recovered");
      await pool.terminate();
    });
  });

  describe("terminate", () => {
    it("rejects queued tasks so no caller is left hanging", async () => {
      const pool = makePool(1);
      const running = pool.run("task-1");
      const queued = pool.run("task-2");
      const terminated = pool.terminate();
      await expect(queued).rejects.toThrow(
        "WorkerPool terminated before task ran",
      );
      await expect(running).rejects.toThrow(
        "WorkerPool terminated while task was in flight",
      );
      await terminated;
    });

    it("terminates every worker and always settles their terminate promises", async () => {
      const pool = makePool(2);
      await pool.terminate();
      expect(workers[0].terminate).toHaveBeenCalled();
      expect(workers[1].terminate).toHaveBeenCalled();
    });

    it("propagates a worker's terminate() rejection (current contract)", async () => {
      // terminate() awaits Promise.all over worker.terminate() with no
      // catch, so a rejecting worker surfaces to the caller.
      const pool = makePool(2);
      workers[0].terminate.mockRejectedValue(new Error("cannot stop"));
      await expect(pool.terminate()).rejects.toThrow("cannot stop");
      // The other worker is still terminated.
      expect(workers[1].terminate).toHaveBeenCalled();
    });

    it("handles worker error event when no job is pending", async () => {
      const pool = makePool(1);
      expect(() => {
        workers[0].emit("error", new Error("idle crash"));
      }).not.toThrow();
      await pool.terminate();
    });

    it("handles worker normal exit (code 0) without error", async () => {
      const pool = makePool(1);
      expect(() => {
        workers[0].emit("exit", 0);
      }).not.toThrow();
      await pool.terminate();
    });

    it("rejects run() calls made after terminate()", async () => {
      const pool = makePool(1);
      await pool.terminate();
      await expect(pool.run("too-late")).rejects.toThrow(
        "WorkerPool has been terminated",
      );
    });

    // For a process on its way out: the caller's tasks must not fail (a
    // failure would be reported as theirs), they simply never finish.
    it("with `abandon`, leaves queued, in-flight and later tasks unsettled, and still stops every worker", async () => {
      const pool = makePool(1);
      const settled: string[] = [];
      const track = (name: string, promise: Promise<string>) =>
        promise.then(
          () => settled.push(`${name} resolved`),
          () => settled.push(`${name} rejected`),
        );
      track("running", pool.run("task-1"));
      track("queued", pool.run("task-2"));
      await pool.terminate({ abandon: true });
      expect(workers[0].terminate).toHaveBeenCalled();
      // A late result or exit from the stopped worker settles nothing.
      completeWith(workers[0], "late");
      workers[0].emit("exit", 1);
      track("later", pool.run("task-3"));
      await new Promise((r) => setImmediate(r));
      expect(settled).toEqual([]);
      expect(WorkerMock).toHaveBeenCalledTimes(1);
    });

    it("a plain terminate after an abandoning one rejects nothing", async () => {
      const pool = makePool(1);
      const running = pool.run("task-1");
      const first = pool.terminate({ abandon: true });
      const second = pool.terminate();
      await Promise.all([first, second]);
      let settled = false;
      void running.then(
        () => (settled = true),
        () => (settled = true),
      );
      await new Promise((r) => setImmediate(r));
      expect(settled).toBe(false);
    });
  });

  // A build starts its pool before it knows how many pages it has (so worker
  // startup overlaps route expansion), then trims it to the job count.
  describe("shrink", () => {
    it("terminates surplus idle workers and never replaces them", async () => {
      const pool = makePool(4);
      await pool.shrink(1);
      expect(pool.size).toBe(1);
      const trimmed = workers.filter((w) => w.terminate.mock.calls.length);
      expect(trimmed).toHaveLength(3);
      // A late exit event from a trimmed worker must not count as a crash.
      for (const w of trimmed) w.emit("exit", 1);
      expect(WorkerMock).toHaveBeenCalledTimes(4);
      const result = pool.run("t1");
      const live = workers.find((w) => w.postMessage.mock.calls.length)!;
      completeWith(live, "r1");
      await expect(result).resolves.toBe("r1");
      await pool.terminate();
    });

    it("keeps the smaller size when a surviving worker later crashes", async () => {
      const pool = makePool(3);
      await pool.shrink(2);
      const first = pool.run("t1");
      const busy = workers.find((w) => w.postMessage.mock.calls.length)!;
      completeWith(busy, "r1");
      await first;
      busy.emit("exit", 1);
      // One replacement for the crashed worker, not a refill to three.
      expect(WorkerMock).toHaveBeenCalledTimes(4);
      expect(pool.size).toBe(2);
      await pool.terminate();
    });

    it("is a no-op when the pool is already at or below the size", async () => {
      const pool = makePool(2);
      await pool.shrink(5);
      expect(pool.size).toBe(2);
      expect(workers.every((w) => w.terminate.mock.calls.length === 0)).toBe(
        true,
      );
      await pool.terminate();
    });

    it("rejects a size below one instead of leaving queued work stranded", async () => {
      const pool = makePool(2);
      expect(() => pool.shrink(0)).toThrow(/at least 1/);
      expect(() => pool.shrink(1.5)).toThrow(/at least 1/);
      expect(pool.size).toBe(2);
      await pool.terminate();
    });

    it("never terminates a worker that holds a task", async () => {
      const pool = makePool(2);
      const pending = pool.run("t1");
      const busy = workers.find((w) => w.postMessage.mock.calls.length)!;
      await pool.shrink(1);
      expect(busy.terminate).not.toHaveBeenCalled();
      completeWith(busy, "r1");
      await expect(pending).resolves.toBe("r1");
      await pool.terminate();
    });

    it("retires a busy surplus worker once its task finishes", async () => {
      const pool = makePool(2);
      const a = pool.run("t1");
      const b = pool.run("t2");
      await pool.shrink(1);
      expect(pool.size).toBe(2);
      const holder = (task: string) =>
        workers.find((w) =>
          w.postMessage.mock.calls.some((c) => c[0] === task),
        )!;
      completeWith(holder("t1"), "r1");
      completeWith(holder("t2"), "r2");
      await expect(Promise.all([a, b])).resolves.toEqual(["r1", "r2"]);
      expect(pool.size).toBe(1);
      await pool.terminate();
    });

    it("trims at once without waiting for the threads to stop", () => {
      // The build dispatches its pages right after trimming; a thread busy
      // loading modules can take a couple of hundred milliseconds to stop.
      const pool = makePool(3);
      for (const w of workers)
        w.terminate.mockReturnValue(new Promise(() => {}));
      void pool.shrink(1);
      expect(pool.size).toBe(1);
      const task = pool.run("t1");
      const live = workers.find((w) => w.postMessage.mock.calls.length)!;
      expect(live).toBeDefined();
      completeWith(live, "r1");
      return expect(task).resolves.toBe("r1");
    });

    it("waits for trimmed workers in terminate()", async () => {
      const pool = makePool(3);
      let release!: () => void;
      workers[2].terminate.mockReturnValueOnce(
        new Promise((resolve) => (release = () => resolve(0))),
      );
      void pool.shrink(1);
      let done = false;
      const terminated = pool.terminate().then(() => (done = true));
      await Promise.resolve();
      await Promise.resolve();
      expect(done).toBe(false);
      release();
      await terminated;
      expect(done).toBe(true);
    });
  });

  // A build starts at most one worker per page before expansion, and grows
  // the pool once a dynamic route turns out to have more jobs than that.
  describe("grow", () => {
    it("spawns workers up to the new size, each with the configured settings first", async () => {
      const pool = makePool(1);
      pool.configure({ kind: "init" });
      pool.grow(3);
      expect(pool.size).toBe(3);
      expect(WorkerMock).toHaveBeenCalledTimes(3);
      for (const w of workers.slice(1))
        expect(w.postMessage.mock.calls[0]).toEqual([{ kind: "init" }]);
      await pool.terminate();
    });

    it("hands queued tasks to the new workers", async () => {
      const pool = makePool(1);
      const a = pool.run("t1");
      const b = pool.run("t2");
      pool.grow(2);
      const holder = (task: string) =>
        workers.find((w) =>
          w.postMessage.mock.calls.some((c) => c[0] === task),
        )!;
      expect(holder("t2")).toBe(workers[1]);
      completeWith(holder("t1"), "r1");
      completeWith(holder("t2"), "r2");
      await expect(Promise.all([a, b])).resolves.toEqual(["r1", "r2"]);
      await pool.terminate();
    });

    it("replaces a later crash up to the grown size", async () => {
      const pool = makePool(1);
      pool.grow(2);
      const task = pool.run("t1");
      const busy = workers.find((w) => w.postMessage.mock.calls.length)!;
      completeWith(busy, "r1");
      await task;
      busy.emit("exit", 1);
      expect(pool.size).toBe(2);
      await pool.terminate();
    });

    it("is a no-op at or below the current size", async () => {
      const pool = makePool(3);
      pool.grow(2);
      pool.grow(3);
      expect(WorkerMock).toHaveBeenCalledTimes(3);
      expect(workers.every((w) => w.terminate.mock.calls.length === 0)).toBe(
        true,
      );
      await pool.terminate();
    });

    it("rejects a size that is not a positive integer", async () => {
      const pool = makePool(1);
      expect(() => pool.grow(0)).toThrow(/at least 1/);
      expect(() => pool.grow(2.5)).toThrow(/at least 1/);
      expect(pool.size).toBe(1);
      await pool.terminate();
    });

    it("spawns nothing after terminate()", async () => {
      const pool = makePool(1);
      await pool.terminate();
      pool.grow(4);
      expect(WorkerMock).toHaveBeenCalledTimes(1);
    });

    it("spawns nothing once worker startup has failed repeatedly", async () => {
      const pool = makePool(1);
      // Each crash before a first task spends one startup attempt.
      for (let i = 0; i < 4; i++) workers[workers.length - 1].emit("exit", 1);
      const spawned = WorkerMock.mock.calls.length;
      pool.grow(4);
      expect(WorkerMock).toHaveBeenCalledTimes(spawned);
      await expect(pool.run("t1")).rejects.toThrow(/no viable workers/);
      await pool.terminate();
    });
  });

  // Settings that must reach every worker before its next task, including a
  // replacement spawned later, without being mistaken for a task reply.
  describe("configure", () => {
    it("posts the message to every live worker and replays it to replacements before their first task", async () => {
      const pool = makePool(2);
      pool.configure({ kind: "settings", n: 1 });
      for (const w of workers)
        expect(w.postMessage).toHaveBeenCalledWith({ kind: "settings", n: 1 });
      workers[0].emit("exit", 1);
      expect(workers).toHaveLength(3);
      expect(workers[2].postMessage.mock.calls[0]).toEqual([
        { kind: "settings", n: 1 },
      ]);
      const task = pool.run("t1");
      const target = workers.find((w) =>
        w.postMessage.mock.calls.some((c) => c[0] === "t1"),
      )!;
      completeWith(target, "r1");
      await expect(task).resolves.toBe("r1");
      await pool.terminate();
    });

    it("replays every message in order, so a replacement ends with the same settings", () => {
      // The build sends the component list first and, after trimming, the
      // worker count; a replacement needs both, applied in the same order.
      const pool = makePool(1);
      pool.configure({ kind: "init" });
      pool.configure({ n: 1 });
      pool.configure({ n: 2 });
      workers[0].emit("exit", 1);
      expect(workers[1].postMessage.mock.calls).toEqual([
        [{ kind: "init" }],
        [{ n: 1 }],
        [{ n: 2 }],
      ]);
      void pool.terminate();
    });

    it("retires a worker that cannot receive the message", async () => {
      const pool = makePool(2);
      workers[0].postMessage.mockImplementationOnce(() => {
        throw new Error("closed port");
      });
      pool.configure({ n: 1 });
      expect(workers[0].terminate).toHaveBeenCalled();
      expect(pool.size).toBe(2);
      await pool.terminate();
    });
  });

  // Node 24 can abort the whole process ("Check failed: (location_) !=
  // nullptr") when a worker is terminated while it is still evaluating an
  // ES module graph with top-level await, which the page worker's is. A pool
  // whose workers announce when they have loaded never stops one before.
  describe("readySignal", () => {
    const makeReadyPool = (size = 2) =>
      new WorkerPool<string, string>(
        "/fake/worker.js",
        size,
        {},
        { readySignal: true },
      );
    const ready = (worker: FakeWorker) =>
      worker.emit("message", { ready: true });

    it("does not stop a trimmed worker until it has loaded", async () => {
      const pool = makeReadyPool(3);
      const trimmed = pool.shrink(1);
      expect(pool.size).toBe(1);
      expect(workers.some((w) => w.terminate.mock.calls.length)).toBe(false);
      for (const w of workers) ready(w);
      await trimmed;
      expect(workers.filter((w) => w.terminate.mock.calls.length)).toHaveLength(
        2,
      );
      await pool.terminate();
    });

    it("waits for every worker to load before terminate() stops it", async () => {
      const pool = makeReadyPool(2);
      let done = false;
      const terminated = pool.terminate().then(() => (done = true));
      await Promise.resolve();
      expect(workers[0].terminate).not.toHaveBeenCalled();
      ready(workers[0]);
      ready(workers[1]);
      await terminated;
      expect(done).toBe(true);
      expect(workers[0].terminate).toHaveBeenCalled();
      expect(workers[1].terminate).toHaveBeenCalled();
    });

    it("does not wait for a worker that exits before it loads", async () => {
      const pool = makeReadyPool(1);
      const terminated = pool.terminate();
      workers[0].emit("exit", 1);
      await expect(terminated).resolves.toBeUndefined();
    });

    it("stops a worker that never loads after a grace period instead of hanging", async () => {
      vi.useFakeTimers();
      try {
        const pool = makeReadyPool(1);
        const terminated = pool.terminate();
        await vi.advanceTimersByTimeAsync(9_000);
        expect(workers[0].terminate).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(workers[0].terminate).toHaveBeenCalled();
        await terminated;
      } finally {
        vi.useRealTimers();
      }
    });

    it("never takes the ready signal for a task result", async () => {
      const pool = makeReadyPool(1);
      const task = pool.run("t1");
      // Loading finishes after the task was queued on the port.
      ready(workers[0]);
      let settled = false;
      void task.then(() => (settled = true));
      await Promise.resolve();
      expect(settled).toBe(false);
      completeWith(workers[0], "r1");
      await expect(task).resolves.toBe("r1");
      await pool.terminate();
    });

    it("stops a loaded worker at once", async () => {
      const pool = makeReadyPool(2);
      for (const w of workers) ready(w);
      await pool.shrink(1);
      expect(workers.filter((w) => w.terminate.mock.calls.length)).toHaveLength(
        1,
      );
      await pool.terminate();
    });
  });
});
