import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { vi } from "vitest";
import { WorkerPool } from "./worker-pool.ts";

/**
 * Real-worker lifecycle tests (actual worker_threads, isolated temp dirs).
 * These live in a separate file from worker-pool.test.ts because that file
 * mocks node:worker_threads for deterministic EventEmitter-style control; a
 * real boundary needs the real module. Each fixture is an .mjs script written
 * to a disposable temp root, so no package fixture is mutated on disk.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixture(name: string, source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), `bascik-wpool-${name}-`));
  tempDirs.push(dir);
  const file = join(dir, "worker.mjs");
  await writeFile(file, source);
  return file;
}

// Exits cleanly with code 0 when asked; echoes every other task.
const EXIT_ON_SIGNAL = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (task) => {
  if (task && task.kind === "exit0") {
    process.exit(0);
    return;
  }
  parentPort.postMessage({ ok: true, result: task });
});
`;

// Auto-exits 0 after a long quiescence (no message). Any message cancels the
// timer and echoes, so a replacement can still serve late work before its own
// timer fires.
const IDLE_EXIT = `
import { parentPort } from "node:worker_threads";
let idle = setTimeout(() => process.exit(0), 700);
parentPort.on("message", (task) => {
  clearTimeout(idle);
  parentPort.postMessage({ ok: true, result: task });
});
`;

// Throws uncaught on the first message (parent sees an "error" event) and the
// worker then exits, exercising the error-followed-by-exit race.
const ERROR_THEN_EXIT = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", () => {
  throw new Error("boom-then-exit");
});
`;

// Throws at module top level: the worker thread can never start, so repeated
// respawn is pointless.
const BROKEN_TOP = `
throw new Error("broken module");
`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("WorkerPool real-worker lifecycle settlement", () => {
  it("settles every task when work is submitted as earlier tasks finish", async () => {
    // The dev pipeline keeps a few tasks per worker in flight and submits the next one as
    // each finishes. A worker that took a queued task was once still listed as idle, so the
    // next submission replaced its task and that task never settled.
    const script = await fixture("waves", EXIT_ON_SIGNAL);
    const pool = new WorkerPool<unknown, unknown>(script, 2, {});
    try {
      const total = 60;
      let next = 0;
      const lane = async (): Promise<unknown[]> => {
        const done: unknown[] = [];
        while (next < total) done.push(await pool.run(`task-${next++}`));
        return done;
      };
      const settled = await Promise.race([
        Promise.all(Array.from({ length: 4 }, lane)),
        sleep(8000).then(() => "timed out" as const),
      ]);
      expect(settled).not.toBe("timed out");
      expect((settled as unknown[][]).flat()).toHaveLength(total);
    } finally {
      await pool.terminate();
    }
  }, 15_000);

  it("rejects a clean exit(0) active task and dispatches the queued task to a replacement", async () => {
    const script = await fixture("exit0", EXIT_ON_SIGNAL);
    const pool = new WorkerPool<unknown, unknown>(script, 1, {});
    try {
      const active = pool.run({ kind: "exit0" });
      await expect(active).rejects.toThrow("Worker exited with code 0");
      // The replacement worker must pick up the second task from the queue.
      const queued = pool.run("queued-ok");
      await expect(queued).resolves.toEqual("queued-ok");
    } finally {
      await pool.terminate();
    }
  }, 10_000);

  it("settles late queued work after an idle clean exit(0) and restores capacity", async () => {
    const script = await fixture("idle", IDLE_EXIT);
    const pool = new WorkerPool<unknown, unknown>(script, 1, {});
    try {
      // Wait past the idle auto-exit window so the first worker dissolves
      // while idle and a replacement is spawned.
      await sleep(1200);
      const late = pool.run("after-idle");
      await expect(late).resolves.toEqual("after-idle");
    } finally {
      await pool.terminate();
    }
  }, 15_000);

  it("settles the active task exactly once when a worker errors then exits", async () => {
    const script = await fixture("err", ERROR_THEN_EXIT);
    const pool = new WorkerPool<unknown, unknown>(script, 1, {});
    try {
      const active = pool.run("task-a");
      await expect(active).rejects.toThrow("boom-then-exit");
    } finally {
      await pool.terminate();
    }
  }, 10_000);

  it("bounded startup failure: a broken module rejects queued callers instead of respawning forever", async () => {
    const script = await fixture("broken", BROKEN_TOP);
    const pool = new WorkerPool<unknown, unknown>(script, 1, {});
    try {
      // No fixed wait: how fast respawns exhaust depends on machine load. A
      // call made before the budget is spent goes to a live broken worker and
      // is rejected with that worker's error. Every call must settle, and at
      // most one call per startup attempt (4) can land before exhaustion.
      const MAX_STARTUP_ATTEMPTS = 4;
      const earlyErrors: string[] = [];
      for (let call = 0; ; call++) {
        const error = await pool.run(`never-${call}`).then(
          () => {
            throw new Error("a broken worker must never resolve a task");
          },
          (rejection: Error) => rejection,
        );
        if (/no viable worker/.test(error.message)) break;
        earlyErrors.push(error.message);
        expect(
          earlyErrors.length,
          `pre-exhaustion rejections: ${earlyErrors.join(" | ")}`,
        ).toBeLessThanOrEqual(MAX_STARTUP_ATTEMPTS);
      }
      for (const message of earlyErrors)
        expect(message).toMatch(/broken module|Worker exited/);
      // Once exhausted, every later caller is rejected immediately.
      await expect(pool.run("after-exhaustion")).rejects.toThrow(
        /no viable worker/,
      );
    } finally {
      await pool.terminate();
    }
  }, 15_000);

  it("explicit shutdown terminates even with a worker that would otherwise auto-exit", async () => {
    const script = await fixture("idle", IDLE_EXIT);
    const pool = new WorkerPool<unknown, unknown>(script, 1, {});
    await pool.terminate();
    // terminate() resolved without leaving a hanging task.
    expect(true).toBe(true);
  }, 10_000);
});

// A build starts its page workers before it knows how many pages it has and
// trims the pool afterwards; the trimmed threads must really stop, during
// startup as well as once idle, and a broken worker module must still settle
// callers instead of hanging the trimmed pool.
describe("WorkerPool real-worker shrink", () => {
  const ECHO = `
import { parentPort } from "node:worker_threads";
parentPort.on("message", (task) => parentPort.postMessage({ ok: true, result: task }));
`;

  const trackTerminated = () => {
    const terminated: Worker[] = [];
    const original = Worker.prototype.terminate;
    const spy = vi
      .spyOn(Worker.prototype, "terminate")
      .mockImplementation(function (this: Worker) {
        terminated.push(this);
        return original.call(this);
      });
    return { terminated, restore: () => spy.mockRestore() };
  };

  it("stops trimmed threads while they are still starting, and the rest keep working", async () => {
    const script = await fixture("shrink-start", ECHO);
    const { terminated, restore } = trackTerminated();
    const pool = new WorkerPool<unknown, unknown>(script, 4, {});
    try {
      // Immediately, before any worker is online: the build trims as soon as
      // expansion finishes, which can be before the workers have loaded.
      await pool.shrink(1);
      expect(pool.size).toBe(1);
      expect(terminated).toHaveLength(3);
      // A worker's threadId becomes -1 once its thread has exited.
      for (const worker of terminated) expect(worker.threadId).toBe(-1);
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => pool.run(`task-${i}`)),
      );
      expect(results).toEqual([
        "task-0",
        "task-1",
        "task-2",
        "task-3",
        "task-4",
      ]);
    } finally {
      await pool.terminate();
      restore();
    }
  }, 15_000);

  it("leaves no thread running after terminate() of a trimmed pool", async () => {
    const script = await fixture("shrink-term", ECHO);
    const { terminated, restore } = trackTerminated();
    const pool = new WorkerPool<unknown, unknown>(script, 3, {});
    try {
      await pool.run("warm");
      await pool.shrink(2);
      await pool.terminate();
      expect(terminated).toHaveLength(3);
      for (const worker of terminated) expect(worker.threadId).toBe(-1);
    } finally {
      restore();
    }
  }, 15_000);

  it("settles callers when the worker module is broken and the pool was trimmed", async () => {
    const script = await fixture("shrink-broken", BROKEN_TOP);
    const pool = new WorkerPool<unknown, unknown>(script, 4, {});
    try {
      await pool.shrink(1);
      const outcome = await Promise.race([
        pool.run("task").then(
          () => "resolved",
          (error: Error) => error.message,
        ),
        sleep(8000).then(() => "timed out"),
      ]);
      expect(outcome).toMatch(/no viable workers|broken module/);
    } finally {
      await pool.terminate();
    }
  }, 15_000);
});
