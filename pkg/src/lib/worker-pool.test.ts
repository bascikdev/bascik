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
  });
});
